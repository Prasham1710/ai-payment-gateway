package com.gateway.orchestrator.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.config.HttpClients;
import com.gateway.orchestrator.dto.BankChargeRequest;
import com.gateway.orchestrator.dto.BankRefundRequest;
import com.gateway.orchestrator.dto.BankResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Set;
import java.util.function.Supplier;

/**
 * HTTP client for the Go bank simulator's provider rails. Classifies every call into a
 * {@link BankResult.Outcome}, erring towards {@code UNKNOWN} whenever the bank might have acted on
 * the request: only a definite "not processed" answer may lead to the request being sent elsewhere.
 */
@Component
@Slf4j
public class BankSimulatorClient {

    private static final Set<String> APPROVED = Set.of("SUCCESS", "PROCESSED");
    private static final int SERVICE_UNAVAILABLE = 503;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String baseUrl;

    public BankSimulatorClient(RestTemplateBuilder builder, GatewayProperties properties, ObjectMapper objectMapper,
                               @Value("${simulator.base-url:http://localhost:8081}") String baseUrl) {
        this.restTemplate = HttpClients.nonThrowing(builder,
                properties.getRouting().getConnectTimeout(), properties.getRouting().getReadTimeout());
        this.objectMapper = objectMapper;
        this.baseUrl = baseUrl;
    }

    public BankResult charge(BankChargeRequest request) {
        return call(() -> restTemplate.postForEntity(baseUrl + "/api/v1/bank/charge", request, String.class), false);
    }

    public BankResult enquire(String transactionId) {
        return call(() -> restTemplate.getForEntity(baseUrl + "/api/v1/bank/status?transaction_id={id}",
                String.class, transactionId), true);
    }

    public BankResult refund(BankRefundRequest request) {
        return call(() -> restTemplate.postForEntity(baseUrl + "/api/v1/bank/refund", request, String.class), false);
    }

    private BankResult call(Supplier<ResponseEntity<String>> request, boolean enquiry) {
        long start = System.nanoTime();
        ResponseEntity<String> response;
        try {
            response = request.get();
        } catch (ResourceAccessException e) {
            // Only a failure to connect proves the bank never saw the request; a read timeout or a
            // reset connection leaves the outcome unknown.
            Throwable cause = e.getCause();
            boolean notSent = cause instanceof ConnectException || cause instanceof UnknownHostException
                    || cause instanceof NoRouteToHostException;
            log.warn("Bank call failed ({}): {}", notSent ? "not sent" : "outcome unknown", e.getMessage());
            return new BankResult(notSent ? BankResult.Outcome.UNAVAILABLE : BankResult.Outcome.UNKNOWN,
                    null, elapsedMs(start), e.getMessage());
        } catch (RestClientException e) {
            // Raised while preparing the request, before anything was sent.
            log.warn("Bank request could not be sent: {}", e.getMessage());
            return new BankResult(BankResult.Outcome.UNAVAILABLE, null, elapsedMs(start), e.getMessage());
        }

        int latency = elapsedMs(start);
        int status = response.getStatusCode().value();
        BankResponse body = parse(response.getBody());
        String bankStatus = body == null || body.getStatus() == null ? null : body.getStatus().toUpperCase(Locale.ROOT);

        if (enquiry && status == 404) {
            return new BankResult(BankResult.Outcome.NOT_FOUND, body, latency, "Transaction not found at the bank");
        }
        if (status == SERVICE_UNAVAILABLE) {
            return new BankResult(BankResult.Outcome.UNAVAILABLE, body, latency, "HTTP 503");
        }
        if (status >= 500) {
            // e.g. a 502/504 from a proxy: the bank may have processed the request before it failed.
            return new BankResult(BankResult.Outcome.UNKNOWN, body, latency, "HTTP " + status);
        }
        if (status >= 400) {
            // A decline carries a bank status; anything else (unknown rail, malformed request) was rejected unprocessed.
            return bankStatus != null
                    ? new BankResult(BankResult.Outcome.DECLINED, body, latency, body.getMessage())
                    : new BankResult(BankResult.Outcome.UNAVAILABLE, body, latency, "HTTP " + status);
        }
        if (bankStatus == null) {
            return new BankResult(BankResult.Outcome.UNKNOWN, body, latency, "Unreadable bank response (HTTP " + status + ")");
        }
        return APPROVED.contains(bankStatus)
                ? new BankResult(BankResult.Outcome.SUCCESS, body, latency, null)
                : new BankResult(BankResult.Outcome.DECLINED, body, latency, body.getMessage());
    }

    private BankResponse parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(raw, BankResponse.class);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static int elapsedMs(long startNanos) {
        return (int) ((System.nanoTime() - startNanos) / 1_000_000);
    }
}
