package com.gateway.orchestrator.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Asks the AI router (services/ai-router) which provider rail to try first, and tells it how each
 * attempt went so it keeps learning.
 *
 * <p>Advice only: the router can reorder the configured rails but never add or drop one, and the
 * failover rules in {@link PaymentOrchestratorService} stay the same. If the router is disabled,
 * slow (past {@code gateway.routing.ai.timeout}) or down, the configured order is used, so payments
 * never depend on it.
 */
@Component
@Slf4j
public class RoutingAdvisor {

    public static final String STATIC = "static";
    private static final long WARNING_INTERVAL_MS = 60_000;

    private final GatewayProperties.Routing routing;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final AtomicLong lastWarningAt = new AtomicLong();

    public record Plan(List<String> providers, String strategy) {
    }

    public RoutingAdvisor(GatewayProperties properties, ObjectMapper objectMapper) {
        this.routing = properties.getRouting();
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(routing.getAi().getTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    public Plan plan(Payment payment) {
        List<String> configured = routing.getProviders();
        if (!routing.getAi().isEnabled()) {
            return new Plan(configured, STATIC);
        }
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("providers", configured);
            body.put("payment_method", payment.getMethod().name());
            body.put("amount", payment.getAmount());
            body.put("currency", payment.getCurrency());
            CompletableFuture<HttpResponse<String>> call = httpClient.sendAsync(post("/v1/route", body), HttpResponse.BodyHandlers.ofString());
            HttpResponse<String> response;
            try {
                response = call.get(routing.getAi().getTimeout().toMillis(), TimeUnit.MILLISECONDS);
            } finally {
                call.cancel(true);
            }
            if (response.statusCode() != 200) {
                return fallback(configured, "HTTP " + response.statusCode());
            }
            JsonNode advice = objectMapper.readTree(response.body());
            List<String> ordered = new ArrayList<>();
            for (JsonNode provider : advice.path("providers")) {
                String id = provider.asText();
                if (configured.contains(id) && !ordered.contains(id)) {
                    ordered.add(id);
                }
            }
            for (String id : configured) {   // never drop a rail the router left out
                if (!ordered.contains(id)) {
                    ordered.add(id);
                }
            }
            return new Plan(ordered, advice.path("strategy").asText("ai"));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fallback(configured, "interrupted");
        } catch (Exception e) {
            return fallback(configured, e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
        }
    }

    /** Reports one attempt to the router without waiting for it; failures are ignored. */
    public void feedback(String provider, Payment payment, AttemptStatus status, Integer latencyMs) {
        if (!routing.getAi().isEnabled()) {
            return;
        }
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("provider", provider);
            body.put("payment_method", payment.getMethod().name());
            body.put("outcome", status.name().toLowerCase(Locale.ROOT));
            body.put("amount", payment.getAmount());
            if (latencyMs != null) {
                body.put("latency_ms", latencyMs);
            }
            httpClient.sendAsync(post("/v1/feedback", body), HttpResponse.BodyHandlers.discarding())
                    .orTimeout(routing.getAi().getTimeout().toMillis() * 10, TimeUnit.MILLISECONDS)
                    .exceptionally(e -> null);
        } catch (Exception e) {
            log.debug("Could not send routing feedback: {}", e.getMessage());
        }
    }

    private HttpRequest post(String path, Map<String, Object> body) throws Exception {
        return HttpRequest.newBuilder(URI.create(routing.getAi().getBaseUrl() + path))
                .timeout(routing.getAi().getTimeout())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .build();
    }

    private Plan fallback(List<String> configured, String reason) {
        long now = System.currentTimeMillis();
        long last = lastWarningAt.get();
        if (now - last > WARNING_INTERVAL_MS && lastWarningAt.compareAndSet(last, now)) {
            log.warn("AI router unavailable ({}); using the configured rail order. Further failures are logged at most once a minute.", reason);
        }
        return new Plan(configured, STATIC);
    }
}
