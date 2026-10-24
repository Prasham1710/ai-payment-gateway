package com.gateway.orchestrator.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gateway.orchestrator.domain.DeliveryStatus;
import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.domain.WebhookDelivery;
import com.gateway.orchestrator.domain.WebhookEndpoint;
import com.gateway.orchestrator.dto.WebhookCreateRequest;
import com.gateway.orchestrator.dto.WebhookDeliveryResponse;
import com.gateway.orchestrator.dto.WebhookResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.WebhookDeliveryRepository;
import com.gateway.orchestrator.repository.WebhookEndpointRepository;
import com.gateway.orchestrator.security.SecretCipher;
import com.gateway.orchestrator.support.Ids;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.URISyntaxException;
import java.time.Instant;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class WebhookService {

    public static final String PAYMENT_AUTHORIZED = "payment.authorized";
    public static final String PAYMENT_CAPTURED = "payment.captured";
    public static final String PAYMENT_FAILED = "payment.failed";
    public static final String ORDER_PAID = "order.paid";
    public static final String REFUND_CREATED = "refund.created";
    public static final String REFUND_PROCESSED = "refund.processed";
    public static final String REFUND_FAILED = "refund.failed";

    public static final List<String> SUPPORTED_EVENTS = List.of(PAYMENT_AUTHORIZED, PAYMENT_CAPTURED, PAYMENT_FAILED,
            ORDER_PAID, REFUND_CREATED, REFUND_PROCESSED, REFUND_FAILED);

    private static final int MIN_SECRET_LENGTH = 8;

    private final WebhookEndpointRepository endpointRepository;
    private final WebhookDeliveryRepository deliveryRepository;
    private final SecretCipher secretCipher;
    private final ObjectMapper objectMapper;

    @Transactional
    public WebhookResponse create(Merchant merchant, WebhookCreateRequest req) {
        String url = validateUrl(req.getUrl());
        if (req.getSecret() == null || req.getSecret().length() < MIN_SECRET_LENGTH) {
            throw GatewayException.badRequest("The secret must be at least " + MIN_SECRET_LENGTH + " characters.", "secret");
        }
        WebhookEndpoint endpoint = endpointRepository.save(WebhookEndpoint.builder()
                .id(Ids.newId("wh"))
                .merchantId(merchant.getId())
                .url(url)
                .secretEncrypted(secretCipher.encrypt(req.getSecret()))
                .events(String.join(",", validateEvents(req.getEvents())))
                .active(true)
                .build());
        return EntityMapper.toResponse(endpoint);
    }

    @Transactional(readOnly = true)
    public List<WebhookResponse> list(Merchant merchant) {
        return endpointRepository.findByMerchantIdOrderByCreatedAtAsc(merchant.getId()).stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public WebhookResponse get(Merchant merchant, String webhookId) {
        return EntityMapper.toResponse(require(merchant, webhookId));
    }

    @Transactional
    public void delete(Merchant merchant, String webhookId) {
        WebhookEndpoint endpoint = require(merchant, webhookId);
        deliveryRepository.failPending(endpoint.getId(), "Webhook endpoint was deleted", DeliveryStatus.PENDING, DeliveryStatus.FAILED);
        endpointRepository.delete(endpoint);
    }

    @Transactional(readOnly = true)
    public List<WebhookDeliveryResponse> deliveries(Merchant merchant, String webhookId, int count) {
        WebhookEndpoint endpoint = require(merchant, webhookId);
        return deliveryRepository.findByEndpointIdOrderByCreatedAtDesc(endpoint.getId(), PageRequest.of(0, count)).stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    /**
     * Queues an event for every subscribed endpoint. Must run inside the transaction that changed the
     * entity (transactional outbox): the event is stored if and only if the change is committed.
     *
     * @param entities entity name to API representation, e.g. {@code "payment" -> PaymentResponse}
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void publish(String merchantId, String event, Map<String, Object> entities) {
        List<WebhookEndpoint> endpoints = endpointRepository.findByMerchantIdAndActiveTrue(merchantId).stream()
                .filter(endpoint -> endpoint.subscribesTo(event))
                .toList();
        if (endpoints.isEmpty()) {
            return;
        }
        String eventId = Ids.newId("evt");
        String payload = serialize(merchantId, event, entities);
        Instant now = Instant.now();
        for (WebhookEndpoint endpoint : endpoints) {
            deliveryRepository.save(WebhookDelivery.builder()
                    .id(Ids.newId("whd"))
                    .eventId(eventId)
                    .endpointId(endpoint.getId())
                    .merchantId(merchantId)
                    .event(event)
                    .payload(payload)
                    .status(DeliveryStatus.PENDING)
                    .attempts(0)
                    .nextAttemptAt(now)
                    .build());
        }
        log.info("Queued {} {} for {} endpoint(s)", event, eventId, endpoints.size());
    }

    /** Razorpay's event envelope: {@code {entity, account_id, event, contains, payload: {payment: {entity: {...}}}, created_at}}. */
    private String serialize(String merchantId, String event, Map<String, Object> entities) {
        Map<String, Object> payload = new LinkedHashMap<>();
        entities.forEach((name, entity) -> payload.put(name, Map.of("entity", entity)));

        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("entity", "event");
        envelope.put("account_id", merchantId);
        envelope.put("event", event);
        envelope.put("contains", new ArrayList<>(entities.keySet()));
        envelope.put("payload", payload);
        envelope.put("created_at", Instant.now().getEpochSecond());
        try {
            return objectMapper.writeValueAsString(envelope);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize webhook payload", e);
        }
    }

    private WebhookEndpoint require(Merchant merchant, String webhookId) {
        return endpointRepository.findByIdAndMerchantId(webhookId, merchant.getId())
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));
    }

    private static String validateUrl(String url) {
        if (url == null || url.isBlank() || url.length() > 2048) {
            throw GatewayException.badRequest("The url field is required.", "url");
        }
        try {
            URI uri = new URI(url.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!(scheme.equals("http") || scheme.equals("https")) || uri.getHost() == null) {
                throw GatewayException.badRequest("The url must be a valid http(s) URL.", "url");
            }
            return uri.toString();
        } catch (URISyntaxException e) {
            throw GatewayException.badRequest("The url must be a valid http(s) URL.", "url");
        }
    }

    private static List<String> validateEvents(List<String> events) {
        if (events == null || events.isEmpty()) {
            throw GatewayException.badRequest("Subscribe to at least one event, or [\"*\"] for all events.", "events");
        }
        Set<String> normalized = new LinkedHashSet<>();
        for (String event : events) {
            String name = event == null ? "" : event.trim().toLowerCase(Locale.ROOT);
            if (!name.equals(WebhookEndpoint.ALL_EVENTS) && !SUPPORTED_EVENTS.contains(name)) {
                throw GatewayException.badRequest("Unsupported event: " + event + ". Supported: " + String.join(", ", SUPPORTED_EVENTS) + ".", "events");
            }
            normalized.add(name);
        }
        return normalized.contains(WebhookEndpoint.ALL_EVENTS) ? List.of(WebhookEndpoint.ALL_EVENTS) : new ArrayList<>(normalized);
    }
}
