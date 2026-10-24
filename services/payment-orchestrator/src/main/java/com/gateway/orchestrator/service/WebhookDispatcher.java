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
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * Delivers queued webhook events. Each delivery is POSTed with an HMAC-SHA256 signature of the raw
 * body ({@code X-Gateway-Signature}) and retried with exponential backoff until the receiver
 * answers 2xx or the attempts run out.
 *
 * <p>How work is picked, so that no merchant or endpoint can hold up the others:
 * <ul>
 *   <li>Endpoints, not deliveries, are scheduled: endpoints with due deliveries are served least
 *       recently claimed first (round robin), each getting at most
 *       {@code max-in-flight-per-endpoint} outstanding sends, and each merchant at most
 *       {@code max-in-flight-per-merchant}.</li>
 *   <li>An endpoint whose delivery fails is paused with exponential backoff, and only probed again
 *       when the pause ends. Its other queued events wait without using up their attempts, and a
 *       dead endpoint cannot keep senders busy.</li>
 *   <li>Only as many deliveries are claimed as there are free senders; when a send finishes the
 *       dispatcher looks for more work straight away, so the limits cap concurrency, not throughput.</li>
 * </ul>
 * A claimed delivery is locked and re-checked before it is leased (its next attempt pushed past the
 * request deadline), and in-flight deliveries are also tracked in memory, so a delivery is never
 * sent twice at once. Runs as a single dispatcher per instance; several instances would need
 * {@code SKIP LOCKED} claiming.
 */
@Component
@Slf4j
public class WebhookDispatcher {

    public static final String SIGNATURE_HEADER = "X-Gateway-Signature";
    public static final String EVENT_ID_HEADER = "X-Gateway-Event-Id";
    public static final String EVENT_HEADER = "X-Gateway-Event";
    /** Placeholder for an empty NOT IN list (no endpoint or merchant has an empty id). */
    private static final Set<String> NONE = Set.of("");
    /** Completions within this window share one refill. */
    private static final long REFILL_DEBOUNCE_MS = 50;

    private final WebhookDeliveryRepository deliveryRepository;
    private final WebhookEndpointRepository endpointRepository;
    private final SecretCipher secretCipher;
    private final WebhookUrlGuard urlGuard;
    private final GatewayProperties.Webhooks settings;
    private final HttpClient httpClient;
    private final TransactionTemplate tx;
    private final ExecutorService senders;
    private final int senderCount;
    private final ExecutorService refiller;

    /** Deliveries claimed and not yet finished, counted per endpoint and per merchant. */
    private final Set<String> outstanding = ConcurrentHashMap.newKeySet();
    private final Map<String, AtomicInteger> outstandingPerEndpoint = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> outstandingPerMerchant = new ConcurrentHashMap<>();
    private final AtomicBoolean refillRequested = new AtomicBoolean();
    private final AtomicInteger claimsRunning = new AtomicInteger();
    private volatile boolean stopping;

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
        this.senders = Executors.newFixedThreadPool(senderCount, task -> daemon(task, "webhook-sender-" + threads.incrementAndGet()));
        this.refiller = Executors.newSingleThreadExecutor(task -> daemon(task, "webhook-refill"));
    }

    private record Job(String deliveryId, String endpointId, String merchantId, String url, String secretEncrypted,
                       String eventId, String event, String payload) {
    }

    @PreDestroy
    void shutdown() throws InterruptedException {
        stopping = true;   // claim nothing new; let in-flight sends record their outcome
        awaitIdle(settings.getTimeout().multipliedBy(2));
        refiller.shutdownNow();
        senders.shutdownNow();
    }

    /** Waits until no delivery is being claimed or sent and no refill is pending. Returns false on timeout. */
    public boolean awaitIdle(Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (!outstanding.isEmpty() || refillRequested.get() || claimsRunning.get() > 0) {
            if (System.nanoTime() > deadline) {
                return false;
            }
            Thread.sleep(10);
        }
        return true;
    }

    /** Claims due deliveries and starts sending them. Returns without waiting; the futures are for callers that want to. */
    @Scheduled(fixedDelayString = "${gateway.webhooks.poll-interval-ms:1000}")
    public List<Future<?>> dispatchDue() {
        claimsRunning.incrementAndGet();
        try {
            return claimAndSend();
        } finally {
            claimsRunning.decrementAndGet();
        }
    }

    private synchronized List<Future<?>> claimAndSend() {
        int freeSenders = senderCount - outstanding.size();
        if (stopping || freeSenders <= 0) {
            return List.of();
        }
        Set<String> busyEndpoints = atLimit(outstandingPerEndpoint, settings.getMaxInFlightPerEndpoint());
        Set<String> busyMerchants = atLimit(outstandingPerMerchant, settings.getMaxInFlightPerMerchant());
        Set<String> inFlight = Set.copyOf(outstanding);
        List<Job> jobs = tx.execute(status -> claim(freeSenders, busyEndpoints, busyMerchants, inFlight));

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
                        refillSoon();      // requested before the slot is released, so awaitIdle never sees a gap
                        finished.run();
                    }
                }));
            } catch (RejectedExecutionException e) {   // shutting down
                finished.run();
            }
        }
        return sends;
    }

    private List<Job> claim(int freeSenders, Set<String> busyEndpoints, Set<String> busyMerchants, Set<String> inFlight) {
        Instant now = Instant.now();
        // Covers the DNS check and the request deadline; deliveries still in flight are skipped anyway.
        Instant leaseUntil = now.plus(settings.getTimeout().multipliedBy(3));
        List<String> endpointIds = endpointRepository.findDispatchable(now, DeliveryStatus.PENDING,
                orNone(busyEndpoints), orNone(busyMerchants), PageRequest.of(0, freeSenders));

        Map<String, Integer> claimedPerMerchant = new HashMap<>();
        List<Job> jobs = new ArrayList<>();
        for (String endpointId : endpointIds) {
            if (jobs.size() >= freeSenders) {
                break;
            }
            WebhookEndpoint endpoint = endpointRepository.findById(endpointId).orElse(null);
            if (endpoint == null) {
                continue;
            }
            int inFlightForEndpoint = count(outstandingPerEndpoint, endpointId);
            int room = settings.getMaxInFlightPerEndpoint() - inFlightForEndpoint;
            boolean claimedAny = false;
            // Ask for a few extra rows: some due rows may be deliveries still in flight whose lease ran out.
            for (String deliveryId : deliveryRepository.findDueIdsForEndpoint(endpointId, DeliveryStatus.PENDING, now,
                    PageRequest.of(0, Math.max(1, room + inFlightForEndpoint)))) {
                int merchantLoad = count(outstandingPerMerchant, endpoint.getMerchantId())
                        + claimedPerMerchant.getOrDefault(endpoint.getMerchantId(), 0);
                if (room <= 0 || jobs.size() >= freeSenders || merchantLoad >= settings.getMaxInFlightPerMerchant()) {
                    break;
                }
                if (inFlight.contains(deliveryId)) {
                    continue;
                }
                // Re-check under the row lock: it may have been delivered or re-scheduled since it was listed.
                WebhookDelivery delivery = deliveryRepository.findByIdForUpdate(deliveryId).orElse(null);
                if (delivery == null || delivery.getStatus() != DeliveryStatus.PENDING || delivery.getNextAttemptAt().isAfter(now)) {
                    continue;
                }
                delivery.setNextAttemptAt(leaseUntil);
                jobs.add(new Job(delivery.getId(), endpointId, endpoint.getMerchantId(), endpoint.getUrl(),
                        endpoint.getSecretEncrypted(), delivery.getEventId(), delivery.getEvent(), delivery.getPayload()));
                room--;
                claimedPerMerchant.merge(endpoint.getMerchantId(), 1, Integer::sum);
                claimedAny = true;
            }
            if (claimedAny) {
                endpointRepository.markClaimed(endpointId, now);
            }
        }
        return jobs;
    }

    private void refillSoon() {
        if (stopping || !refillRequested.compareAndSet(false, true)) {
            return;
        }
        try {
            refiller.execute(() -> {
                try {
                    Thread.sleep(REFILL_DEBOUNCE_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    refillRequested.set(false);
                    return;
                }
                claimsRunning.incrementAndGet();
                refillRequested.set(false);
                try {
                    claimAndSend();
                } catch (RuntimeException e) {
                    log.error("Webhook refill failed", e);
                } finally {
                    claimsRunning.decrementAndGet();
                }
            });
        } catch (RejectedExecutionException e) {   // shutting down
            refillRequested.set(false);
        }
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
        tx.executeWithoutResult(status -> record(job, responseCode, failure));
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

    private void record(Job job, Integer statusCode, String error) {
        WebhookDelivery delivery = deliveryRepository.findByIdForUpdate(job.deliveryId()).orElseThrow();
        if (delivery.getStatus() != DeliveryStatus.PENDING) {
            return;
        }
        Instant now = Instant.now();
        delivery.setAttempts(delivery.getAttempts() + 1);
        delivery.setLastResponseCode(statusCode);
        if (error == null) {
            delivery.setStatus(DeliveryStatus.DELIVERED);
            delivery.setDeliveredAt(now);
            delivery.setLastError(null);
            endpointRepository.markHealthy(job.endpointId());
            log.info("Delivered {} {} (attempt {})", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts());
            return;
        }
        delivery.setLastError(Text.truncate(error, 255));
        if (delivery.getAttempts() >= settings.getMaxAttempts()) {
            delivery.setStatus(DeliveryStatus.FAILED);
            log.warn("Giving up on {} {} after {} attempts: {}", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts(), error);
        } else {
            delivery.setNextAttemptAt(now.plus(backoff(delivery.getAttempts())));
            log.warn("Delivery of {} {} failed (attempt {}): {}", delivery.getEvent(), delivery.getEventId(), delivery.getAttempts(), error);
        }
        // Pause the whole endpoint, so its other queued events wait instead of each failing in turn.
        int failures = endpointRepository.findById(job.endpointId()).map(WebhookEndpoint::getConsecutiveFailures).orElse(0) + 1;
        endpointRepository.markFailing(job.endpointId(), now.plus(backoff(failures)));
    }

    /** base, 2x base, 4x base, ... capped at maxBackoff. */
    private Duration backoff(int attempts) {
        Duration delay = settings.getBaseBackoff().multipliedBy(1L << Math.min(Math.max(attempts, 1) - 1, 20));
        return delay.compareTo(settings.getMaxBackoff()) > 0 ? settings.getMaxBackoff() : delay;
    }

    private static Set<String> atLimit(Map<String, AtomicInteger> counters, int limit) {
        return counters.entrySet().stream()
                .filter(e -> e.getValue().get() >= limit)
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
    }

    private static Set<String> orNone(Set<String> ids) {
        return ids.isEmpty() ? NONE : ids;
    }

    private static int count(Map<String, AtomicInteger> counters, String key) {
        AtomicInteger counter = counters.get(key);
        return counter == null ? 0 : counter.get();
    }

    private static Thread daemon(Runnable task, String name) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }
}
