package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.DeliveryStatus;
import com.gateway.orchestrator.domain.WebhookDelivery;
import com.gateway.orchestrator.domain.WebhookEndpoint;
import com.gateway.orchestrator.repository.WebhookDeliveryRepository;
import com.gateway.orchestrator.repository.WebhookEndpointRepository;
import com.gateway.orchestrator.security.SecretCipher;
import com.gateway.orchestrator.security.WebhookUrlGuard;
import com.gateway.orchestrator.support.Signatures;
import com.gateway.orchestrator.support.Text;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * Delivers queued webhook events. Each delivery is POSTed with an HMAC-SHA256 signature of the raw
 * body ({@code X-Gateway-Signature}) and retried with exponential backoff until the receiver
 * answers 2xx or the attempts run out.
 *
 * <p>One receiver cannot hold up everyone else: every request has a hard deadline (headers and
 * body), the poll hands deliveries to a sender pool without waiting for them, and an endpoint never
 * has more than {@link #MAX_IN_FLIGHT_PER_ENDPOINT} deliveries in flight. A claimed delivery is
 * leased (its next attempt pushed past the deadline) so later polls skip it while it is being sent.
 * Runs as a single poller per instance; several instances would need row locking on the claim.
 */
@Component
@Slf4j
public class WebhookDispatcher {

    public static final String SIGNATURE_HEADER = "X-Gateway-Signature";
    public static final String EVENT_ID_HEADER = "X-Gateway-Event-Id";
    public static final String EVENT_HEADER = "X-Gateway-Event";
    static final int MAX_IN_FLIGHT_PER_ENDPOINT = 2;
    /** Placeholder for an empty NOT IN list (no endpoint has an empty id). */
    private static final String NO_ENDPOINT = "";

    private final WebhookDeliveryRepository deliveryRepository;
    private final WebhookEndpointRepository endpointRepository;
    private final SecretCipher secretCipher;
    private final WebhookUrlGuard urlGuard;
    private final GatewayProperties.Webhooks settings;
    private final HttpClient httpClient;
    private final TransactionTemplate tx;
    private final ExecutorService senders;
    private final Map<String, AtomicInteger> inFlightPerEndpoint = new ConcurrentHashMap<>();

    public WebhookDispatcher(WebhookDeliveryRepository deliveryRepository, WebhookEndpointRepository endpointRepository,
                             SecretCipher secretCipher, WebhookUrlGuard urlGuard, GatewayProperties properties,
                             PlatformTransactionManager transactionManager) {
        this.deliveryRepository = deliveryRepository;
        this.endpointRepository = endpointRepository;
        this.secretCipher = secretCipher;
        this.urlGuard = urlGuard;
        this.settings = properties.getWebhooks();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(settings.getTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)   // a redirect could point at an internal address
                .build();
        this.tx = new TransactionTemplate(transactionManager);
        AtomicInteger threads = new AtomicInteger();
        this.senders = Executors.newFixedThreadPool(Math.max(1, settings.getConcurrency()), task -> {
            Thread thread = new Thread(task, "webhook-sender-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    private record Job(String deliveryId, String endpointId, String url, String secret, String eventId, String event,
                       String payload) {
    }

    @PreDestroy
    void shutdown() {
        senders.shutdownNow();
    }

    /** Claims due deliveries and hands them to the sender pool. Returns without waiting; the futures are for callers that want to. */
    @Scheduled(fixedDelayString = "${gateway.webhooks.poll-interval-ms:2000}")
    public List<Future<?>> dispatchDue() {
        Set<String> busy = inFlightPerEndpoint.entrySet().stream()
                .filter(e -> e.getValue().get() >= MAX_IN_FLIGHT_PER_ENDPOINT)
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
        List<Job> jobs = tx.execute(status -> claimDue(busy.isEmpty() ? Set.of(NO_ENDPOINT) : busy));
        List<Future<?>> sends = new ArrayList<>();
        for (Job job : jobs) {
            AtomicInteger inFlight = inFlightPerEndpoint.computeIfAbsent(job.endpointId(), id -> new AtomicInteger());
            inFlight.incrementAndGet();
            try {
                sends.add(senders.submit(() -> {
                    try {
                        send(job);
                    } catch (RuntimeException e) {
                        log.error("Webhook delivery {} crashed", job.deliveryId(), e);
                    } finally {
                        inFlight.decrementAndGet();
                    }
                }));
            } catch (RuntimeException e) {   // pool shut down
                inFlight.decrementAndGet();
                throw e;
            }
        }
        return sends;
    }

    private List<Job> claimDue(Set<String> busyEndpoints) {
        Instant now = Instant.now();
        Instant leaseUntil = now.plus(settings.getTimeout().multipliedBy(3));
        Map<String, Integer> claimedPerEndpoint = new HashMap<>();
        List<Job> jobs = new ArrayList<>();
        for (WebhookDelivery delivery : deliveryRepository.findDue(DeliveryStatus.PENDING, now, busyEndpoints,
                PageRequest.of(0, settings.getBatchSize()))) {
            AtomicInteger inFlight = inFlightPerEndpoint.get(delivery.getEndpointId());
            int claimed = claimedPerEndpoint.merge(delivery.getEndpointId(), 1, Integer::sum);
            if ((inFlight == null ? 0 : inFlight.get()) + claimed > MAX_IN_FLIGHT_PER_ENDPOINT) {
                continue;   // stays due; picked up once this endpoint has capacity again
            }
            WebhookEndpoint endpoint = endpointRepository.findById(delivery.getEndpointId()).orElse(null);
            if (endpoint == null || !endpoint.isActive()) {
                delivery.setStatus(DeliveryStatus.FAILED);
                delivery.setLastError("Webhook endpoint no longer exists or is inactive");
                continue;
            }
            delivery.setNextAttemptAt(leaseUntil);
            jobs.add(new Job(delivery.getId(), endpoint.getId(), endpoint.getUrl(),
                    secretCipher.decrypt(endpoint.getSecretEncrypted()), delivery.getEventId(), delivery.getEvent(),
                    delivery.getPayload()));
        }
        return jobs;
    }

    private void send(Job job) {
        Integer statusCode = null;
        String error = null;
        try {
            URI uri = URI.create(job.url());
            String blocked = urlGuard.rejectionReason(uri);
            if (blocked != null) {
                error = "Not sent: " + blocked;
            } else {
                statusCode = post(uri, job);
                if (statusCode < 200 || statusCode >= 300) {
                    error = "Receiver responded with HTTP " + statusCode;
                }
            }
        } catch (RuntimeException e) {
            // Anything else still counts as a failed attempt, so retries stay bounded.
            error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        }
        Integer responseCode = statusCode;
        String failure = error;
        tx.executeWithoutResult(status -> record(job.deliveryId(), responseCode, failure));
    }

    /** POSTs the signed payload; the response body is discarded and the whole exchange must finish within the timeout. */
    private int post(URI uri, Job job) {
        byte[] body = job.payload().getBytes(StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(settings.getTimeout())
                .header("Content-Type", "application/json")
                .header("User-Agent", "AI-Payment-Gateway-Webhooks/1.0")
                .header(SIGNATURE_HEADER, Signatures.hmacSha256Hex(body, job.secret()))
                .header(EVENT_ID_HEADER, job.eventId())
                .header(EVENT_HEADER, job.event())
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        CompletableFuture<HttpResponse<Void>> response = httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding());
        try {
            return response.get(settings.getTimeout().toMillis(), TimeUnit.MILLISECONDS).statusCode();
        } catch (TimeoutException e) {
            response.cancel(true);
            throw new IllegalStateException("Receiver did not respond within " + settings.getTimeout().toMillis() + " ms");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw new IllegalStateException(cause.getMessage() != null ? cause.getMessage() : cause.getClass().getSimpleName());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            response.cancel(true);
            throw new IllegalStateException("Interrupted while delivering");
        }
    }

    private void record(String deliveryId, Integer statusCode, String error) {
        WebhookDelivery delivery = deliveryRepository.findByIdForUpdate(deliveryId).orElseThrow();
        if (delivery.getStatus() != DeliveryStatus.PENDING) {
            return;
        }
        delivery.setAttempts(delivery.getAttempts() + 1);
        delivery.setLastResponseCode(statusCode);
        if (error == null) {
            delivery.setStatus(DeliveryStatus.DELIVERED);
            delivery.setDeliveredAt(Instant.now());
            delivery.setLastError(null);
            log.info("Delivered {} {} (attempt {})", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts());
            return;
        }
        delivery.setLastError(Text.truncate(error, 255));
        if (delivery.getAttempts() >= settings.getMaxAttempts()) {
            delivery.setStatus(DeliveryStatus.FAILED);
            log.warn("Giving up on {} {} after {} attempts: {}", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts(), error);
        } else {
            delivery.setNextAttemptAt(Instant.now().plus(backoff(delivery.getAttempts())));
            log.warn("Delivery of {} {} failed (attempt {}): {}", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts(), error);
        }
    }

    /** base, 2x base, 4x base, ... capped at maxBackoff. */
    private Duration backoff(int attempts) {
        Duration delay = settings.getBaseBackoff().multipliedBy(1L << Math.min(attempts - 1, 20));
        return delay.compareTo(settings.getMaxBackoff()) > 0 ? settings.getMaxBackoff() : delay;
    }
}
