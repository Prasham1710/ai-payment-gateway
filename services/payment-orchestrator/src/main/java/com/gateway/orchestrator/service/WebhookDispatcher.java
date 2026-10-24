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
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Delivers queued webhook events. Each delivery is POSTed with an HMAC-SHA256 signature of the raw
 * body ({@code X-Gateway-Signature}) and retried with exponential backoff until the receiver
 * answers 2xx or the attempts run out.
 *
 * <p>Fairness: due deliveries are picked oldest-first but at most
 * {@code max-in-flight-per-endpoint} per endpoint per poll (window query), so no merchant's
 * backlog crowds out others; an endpoint never has more than {@code max-in-flight-per-endpoint}
 * deliveries outstanding (a dead endpoint cannot starve the merchant's healthy ones) and a
 * merchant never more than {@code max-in-flight-per-merchant} (one merchant cannot take every
 * sender, including while its DNS lookups hang). Every request has a hard deadline. When a send
 * finishes, the dispatcher immediately looks for more work, so the caps limit concurrency, not
 * throughput.
 *
 * <p>Claimed deliveries are leased (next attempt pushed out) and tracked in memory until they
 * finish, so a delivery is never sent twice at once. Runs as a single poller per instance; several
 * instances would need row locking on the claim.
 */
@Component
@Slf4j
public class WebhookDispatcher {

    public static final String SIGNATURE_HEADER = "X-Gateway-Signature";
    public static final String EVENT_ID_HEADER = "X-Gateway-Event-Id";
    public static final String EVENT_HEADER = "X-Gateway-Event";
    /** How many deliveries may wait for a sender, per sender thread. */
    private static final int QUEUE_PER_SENDER = 3;

    private final WebhookDeliveryRepository deliveryRepository;
    private final WebhookEndpointRepository endpointRepository;
    private final SecretCipher secretCipher;
    private final WebhookUrlGuard urlGuard;
    private final GatewayProperties.Webhooks settings;
    private final HttpClient httpClient;
    private final TransactionTemplate tx;
    private final ExecutorService senders;
    private final int senderCount;
    /** Re-runs {@link #dispatchDue()} when a send frees capacity; requests are coalesced. */
    private final ExecutorService refiller;
    private final AtomicBoolean refillRequested = new AtomicBoolean();
    /** Deliveries claimed and not yet finished (queued or being sent), counted per endpoint and per merchant. */
    private final Set<String> outstanding = ConcurrentHashMap.newKeySet();
    private final Map<String, AtomicInteger> outstandingPerEndpoint = new ConcurrentHashMap<>();
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
        this.refiller = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "webhook-refill");
            thread.setDaemon(true);
            return thread;
        });
    }

    private record Job(String deliveryId, String endpointId, String merchantId, String url, String secretEncrypted,
                       String eventId, String event, String payload) {
    }

    @PreDestroy
    void shutdown() throws InterruptedException {
        // Let in-flight sends record their outcome; anything still unfinished is retried after its lease.
        awaitIdle(settings.getTimeout());
        refiller.shutdownNow();
        senders.shutdownNow();
    }

    /** Waits until no delivery is queued or being sent. Returns false if that did not happen in time. */
    public boolean awaitIdle(Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (!outstanding.isEmpty() || refillRequested.get()) {
            if (System.nanoTime() > deadline) {
                return false;
            }
            Thread.sleep(10);
        }
        return true;
    }

    private void refillSoon() {
        if (refillRequested.compareAndSet(false, true)) {
            try {
                refiller.execute(() -> {
                    refillRequested.set(false);
                    try {
                        dispatchDue();
                    } catch (RuntimeException e) {
                        log.error("Webhook refill failed", e);
                    }
                });
            } catch (RuntimeException e) {   // shutting down
                refillRequested.set(false);
            }
        }
    }

    /** Claims due deliveries and hands them to the sender pool. Returns without waiting; the futures are for callers that want to. */
    @Scheduled(fixedDelayString = "${gateway.webhooks.poll-interval-ms:1000}")
    public synchronized List<Future<?>> dispatchDue() {
        int capacity = senderCount * (1 + QUEUE_PER_SENDER) - outstanding.size();
        if (capacity <= 0) {
            return List.of();
        }
        List<Job> jobs = tx.execute(status -> claimDue(capacity));
        List<Future<?>> sends = new ArrayList<>();
        for (Job job : jobs) {
            AtomicInteger perEndpoint = outstandingPerEndpoint.computeIfAbsent(job.endpointId(), id -> new AtomicInteger());
            AtomicInteger perMerchant = outstandingPerMerchant.computeIfAbsent(job.merchantId(), id -> new AtomicInteger());
            perEndpoint.incrementAndGet();
            perMerchant.incrementAndGet();
            outstanding.add(job.deliveryId());
            Runnable finished = () -> {
                outstanding.remove(job.deliveryId());
                perEndpoint.decrementAndGet();
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
                        refillSoon();
                    }
                }));
            } catch (RuntimeException e) {   // pool shut down
                finished.run();
                throw e;
            }
        }
        return sends;
    }

    private List<Job> claimDue(int capacity) {
        Instant now = Instant.now();
        // Covers the DNS check, the request deadline and some queueing; an expired lease is harmless
        // because outstanding deliveries are skipped below anyway.
        Instant leaseUntil = now.plus(settings.getTimeout().multipliedBy(3));
        int perEndpointCap = settings.getMaxInFlightPerEndpoint();
        int perMerchantCap = settings.getMaxInFlightPerMerchant();
        List<String> candidates = deliveryRepository.findDueIdsFairly(now, perEndpointCap,
                Math.max(settings.getBatchSize(), capacity * 3));
        Map<String, WebhookDelivery> deliveries = new HashMap<>();
        deliveryRepository.findAllById(candidates).forEach(d -> deliveries.put(d.getId(), d));

        Map<String, Integer> claimedPerEndpoint = new HashMap<>();
        Map<String, Integer> claimedPerMerchant = new HashMap<>();
        List<Job> jobs = new ArrayList<>();
        for (String id : candidates) {
            WebhookDelivery delivery = deliveries.get(id);
            if (jobs.size() >= capacity) {
                break;
            }
            if (delivery == null || outstanding.contains(id) || delivery.getStatus() != DeliveryStatus.PENDING) {
                continue;
            }
            if (count(outstandingPerEndpoint, delivery.getEndpointId()) + claimedPerEndpoint.getOrDefault(delivery.getEndpointId(), 0) >= perEndpointCap
                    || count(outstandingPerMerchant, delivery.getMerchantId()) + claimedPerMerchant.getOrDefault(delivery.getMerchantId(), 0) >= perMerchantCap) {
                continue;   // stays due; picked up once the endpoint/merchant has capacity again
            }
            WebhookEndpoint endpoint = endpointRepository.findById(delivery.getEndpointId()).orElse(null);
            if (endpoint == null || !endpoint.isActive()) {
                delivery.setStatus(DeliveryStatus.FAILED);
                delivery.setLastError("Webhook endpoint no longer exists or is inactive");
                continue;
            }
            claimedPerEndpoint.merge(delivery.getEndpointId(), 1, Integer::sum);
            claimedPerMerchant.merge(delivery.getMerchantId(), 1, Integer::sum);
            delivery.setNextAttemptAt(leaseUntil);
            jobs.add(new Job(delivery.getId(), delivery.getEndpointId(), delivery.getMerchantId(), endpoint.getUrl(),
                    endpoint.getSecretEncrypted(), delivery.getEventId(), delivery.getEvent(), delivery.getPayload()));
        }
        return jobs;
    }

    private static int count(Map<String, AtomicInteger> counters, String key) {
        AtomicInteger counter = counters.get(key);
        return counter == null ? 0 : counter.get();
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
        String timedOut = "Receiver did not respond within " + settings.getTimeout().toMillis() + " ms";
        try {
            return response.get(settings.getTimeout().toMillis(), TimeUnit.MILLISECONDS).statusCode();
        } catch (TimeoutException e) {
            response.cancel(true);
            throw new IllegalStateException(timedOut);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof HttpTimeoutException) {   // the client's own deadline fired first
                throw new IllegalStateException(timedOut);
            }
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
