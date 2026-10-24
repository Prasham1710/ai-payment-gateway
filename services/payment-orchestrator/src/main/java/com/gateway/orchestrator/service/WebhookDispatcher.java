package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.config.HttpClients;
import com.gateway.orchestrator.domain.DeliveryStatus;
import com.gateway.orchestrator.domain.WebhookDelivery;
import com.gateway.orchestrator.domain.WebhookEndpoint;
import com.gateway.orchestrator.repository.WebhookDeliveryRepository;
import com.gateway.orchestrator.repository.WebhookEndpointRepository;
import com.gateway.orchestrator.security.SecretCipher;
import com.gateway.orchestrator.support.Signatures;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Delivers queued webhook events. Each delivery is POSTed with an HMAC-SHA256 signature of the raw
 * body ({@code X-Gateway-Signature}) and retried with exponential backoff until the receiver
 * answers 2xx or the attempts run out.
 *
 * <p>Runs as a single poller per instance; running several instances would need row claiming
 * (e.g. {@code SELECT ... FOR UPDATE SKIP LOCKED}) to avoid duplicate deliveries.
 */
@Component
@Slf4j
public class WebhookDispatcher {

    public static final String SIGNATURE_HEADER = "X-Gateway-Signature";
    public static final String EVENT_ID_HEADER = "X-Gateway-Event-Id";
    public static final String EVENT_HEADER = "X-Gateway-Event";

    private final WebhookDeliveryRepository deliveryRepository;
    private final WebhookEndpointRepository endpointRepository;
    private final SecretCipher secretCipher;
    private final GatewayProperties.Webhooks settings;
    private final RestTemplate restTemplate;
    private final TransactionTemplate tx;

    public WebhookDispatcher(WebhookDeliveryRepository deliveryRepository, WebhookEndpointRepository endpointRepository,
                             SecretCipher secretCipher, GatewayProperties properties, RestTemplateBuilder builder,
                             PlatformTransactionManager transactionManager) {
        this.deliveryRepository = deliveryRepository;
        this.endpointRepository = endpointRepository;
        this.secretCipher = secretCipher;
        this.settings = properties.getWebhooks();
        this.restTemplate = HttpClients.nonThrowing(builder, settings.getTimeout(), settings.getTimeout());
        this.tx = new TransactionTemplate(transactionManager);
    }

    private record Job(String url, String secret, String eventId, String event, String payload) {
    }

    @Scheduled(fixedDelayString = "${gateway.webhooks.poll-interval-ms:2000}")
    public void dispatchDue() {
        List<String> due = tx.execute(status -> deliveryRepository.findDueIds(DeliveryStatus.PENDING, Instant.now(),
                PageRequest.of(0, settings.getBatchSize())));
        for (String deliveryId : due) {
            try {
                deliver(deliveryId);
            } catch (RuntimeException e) {
                log.error("Webhook delivery {} crashed", deliveryId, e);
            }
        }
    }

    public void deliver(String deliveryId) {
        Job job = tx.execute(status -> prepare(deliveryId));
        if (job == null) {
            return;
        }
        byte[] body = job.payload().getBytes(StandardCharsets.UTF_8);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(SIGNATURE_HEADER, Signatures.hmacSha256Hex(body, job.secret()));
        headers.set(EVENT_ID_HEADER, job.eventId());
        headers.set(EVENT_HEADER, job.event());
        headers.set(HttpHeaders.USER_AGENT, "AI-Payment-Gateway-Webhooks/1.0");

        Integer statusCode = null;
        String error = null;
        try {
            // URI, not String: a String URL would be expanded as a URI template.
            statusCode = restTemplate.exchange(URI.create(job.url()), HttpMethod.POST, new HttpEntity<>(body, headers), String.class)
                    .getStatusCode().value();
            if (statusCode < 200 || statusCode >= 300) {
                error = "Receiver responded with HTTP " + statusCode;
            }
        } catch (RuntimeException e) {
            // Network errors and anything else still count as a failed attempt, so retries stay bounded.
            error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        }
        Integer responseCode = statusCode;
        String failure = error;
        tx.executeWithoutResult(status -> record(deliveryId, responseCode, failure));
    }

    private Job prepare(String deliveryId) {
        WebhookDelivery delivery = deliveryRepository.findById(deliveryId).orElse(null);
        if (delivery == null || delivery.getStatus() != DeliveryStatus.PENDING) {
            return null;
        }
        WebhookEndpoint endpoint = endpointRepository.findById(delivery.getEndpointId()).orElse(null);
        if (endpoint == null || !endpoint.isActive()) {
            delivery.setStatus(DeliveryStatus.FAILED);
            delivery.setLastError("Webhook endpoint no longer exists or is inactive");
            return null;
        }
        return new Job(endpoint.getUrl(), secretCipher.decrypt(endpoint.getSecretEncrypted()),
                delivery.getEventId(), delivery.getEvent(), delivery.getPayload());
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
        delivery.setLastError(error.length() > 255 ? error.substring(0, 255) : error);
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
