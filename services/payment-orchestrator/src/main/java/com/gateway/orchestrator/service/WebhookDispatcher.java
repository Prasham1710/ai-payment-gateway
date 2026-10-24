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
 * <p>One receiver cannot hold up everyone else: every request (and its DNS check) has a hard
 * deadline, the poll hands deliveries to the sender pool without waiting for them, it only claims
 * as many deliveries as there are free senders, and a merchant never has more than
 * {@code gateway.webhooks.max-in-flight-per-merchant} deliveries outstanding. A claimed delivery is
 * leased (its next attempt pushed past the deadline) and tracked in memory until it finishes, so it
 * is never sent twice at once. Runs as a single poller per instance; several instances would need
 * row locking on the claim.
 */
@Component
@Slf4j
public class WebhookDispatcher {

    public static final String SIGNATURE_HEADER = "X-Gateway-Signature";
    public static final String EVENT_ID_HEADER = "X-Gateway-Event-Id";
    public static final String EVENT_HEADER = "X-Gateway-Event";
    /** Placeholder for an empty NOT IN list (no merchant or delivery has an empty id). */
    private static final Set<String> NONE = Set.of("");

    private final WebhookDeliveryRepository deliveryRepository;
    private final WebhookEndpointRepository endpointRepository;
    private final SecretCipher secretCipher;
    private final WebhookUrlGuard urlGuard;
    private final GatewayProperties.Webhooks settings;
    private final HttpClient httpClient;
    private final TransactionTemplate tx;
    private final ExecutorService senders;
    private final int senderCount;
    /** Deliveries claimed and not yet finished (queued or being sent), and how many each merchant has. */
    private final Set<String> outstanding = ConcurrentHashMap.newKeySet();
    private final Map<String, AtomicInteger> outstandingPerMerchant = new ConcurrentHashMap<>();

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
        this.senderCount = Math.max(1, settings.getConcurrency());
        this.senders = Executors.newFixedThreadPool(senderCount, task -> {
            Thread thread = new Thread(task, "webhook-sender-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    private record Job(String deliveryId, String merchantId, String url, String secretEncrypted, String eventId,
                       String event, String payload) {
    }

    @PreDestroy
    void shutdown() {
        senders.shutdownNow();
    }

    /** Claims due deliveries and hands them to the sender pool. Returns without waiting; the futures are for callers that want to. */
    @Scheduled(fixedDelayString = "${gateway.webhooks.poll-interval-ms:2000}")
    public synchronized List<Future<?>> dispatchDue() {
        int freeSenders = senderCount - outstanding.size();
        if (freeSenders <= 0) {
            return List.of();
        }
        Set<String> busyMerchants = outstandingPerMerchant.entrySet().stream()
                .filter(e -> e.getValue().get() >= settings.getMaxInFlightPerMerchant())
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
        Set<String> excludedDeliveries = outstanding.isEmpty() ? NONE : Set.copyOf(outstanding);
        List<Job> jobs = tx.execute(status -> claimDue(busyMerchants.isEmpty() ? NONE : busyMerchants,
                excludedDeliveries, freeSenders));
        List<Future<?>> sends = new ArrayList<>();
        for (Job job : jobs) {
            AtomicInteger perMerchant = outstandingPerMerchant.computeIfAbsent(job.merchantId(), id -> new AtomicInteger());
            perMerchant.incrementAndGet();
            outstanding.add(job.deliveryId());
            Runnable finished = () -> {
                outstanding.remove(job.deliveryId());
                perMerchant.decrementAndGet();
            };
            try {
                sends.add(senders.submit(() -> {
                    try {
                        send(job);
                    } catch (RuntimeException e) {
                        log.error("Webhook delivery {} crashed", job.deliveryId(), e);
                    } finally {
                        finished.run();
                    }
                }));
            } catch (RuntimeException e) {   // pool shut down
                finished.run();
                throw e;
            }
        }
        return sends;
    }

    private List<Job> claimDue(Set<String> busyMerchants, Set<String> excludedDeliveries, int freeSenders) {
        Instant now = Instant.now();
        // DNS check and request each have a deadline of one timeout; the lease covers both with room to spare.
        Instant leaseUntil = now.plus(settings.getTimeout().multipliedBy(3));
        Map<String, Integer> claimedPerMerchant = new HashMap<>();
        List<Job> jobs = new ArrayList<>();
        for (WebhookDelivery delivery : deliveryRepository.findDue(DeliveryStatus.PENDING, now, busyMerchants,
                excludedDeliveries, PageRequest.of(0, settings.getBatchSize()))) {
            if (jobs.size() >= freeSenders) {
                break;   // only claim what can start right away, so a lease never expires in a queue
            }
            AtomicInteger outstandingForMerchant = outstandingPerMerchant.get(delivery.getMerchantId());
            int claimed = claimedPerMerchant.merge(delivery.getMerchantId(), 1, Integer::sum);
            if ((outstandingForMerchant == null ? 0 : outstandingForMerchant.get()) + claimed > settings.getMaxInFlightPerMerchant()) {
                continue;   // stays due; picked up once this merchant has capacity again
            }
            WebhookEndpoint endpoint = endpointRepository.findById(delivery.getEndpointId()).orElse(null);
            if (endpoint == null || !endpoint.isActive()) {
                delivery.setStatus(DeliveryStatus.FAILED);
                delivery.setLastError("Webhook endpoint no longer exists or is inactive");
                continue;
            }
            delivery.setNextAttemptAt(leaseUntil);
            jobs.add(new Job(delivery.getId(), delivery.getMerchantId(), endpoint.getUrl(), endpoint.getSecretEncrypted(),
                    delivery.getEventId(), delivery.getEvent(), delivery.getPayload()));
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
        String secret;
        try {
            // Decrypted per delivery: one unreadable secret only fails that endpoint's deliveries.
            secret = secretCipher.decrypt(job.secretEncrypted());
        } catch (RuntimeException e) {
            throw new IllegalStateException("Webhook secret could not be decrypted; re-create the webhook endpoint");
        }
        byte[] body = job.payload().getBytes(StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(settings.getTimeout())
                .header("Content-Type", "application/json")
                .header("User-Agent", "AI-Payment-Gateway-Webhooks/1.0")
                .header(SIGNATURE_HEADER, Signatures.hmacSha256Hex(body, secret))
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
