package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.config.HttpClients;
import com.gateway.orchestrator.dto.BankChargeRequest;
import com.gateway.orchestrator.dto.BankRefundRequest;
import com.gateway.orchestrator.dto.BankResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.HttpStatusCode;
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

/** HTTP client for the Go bank simulator's provider rails. Classifies every call into a {@link BankResult.Outcome}. */
@Component
@Slf4j
public class BankSimulatorClient {

    private static final Set<String> APPROVED = Set.of("SUCCESS", "PROCESSED");

    private final RestTemplate restTemplate;
    private final String baseUrl;

    public BankSimulatorClient(RestTemplateBuilder builder, GatewayProperties properties,
                               @Value("${simulator.base-url:http://localhost:8081}") String baseUrl) {
        this.restTemplate = HttpClients.nonThrowing(builder,
                properties.getRouting().getConnectTimeout(), properties.getRouting().getReadTimeout());
        this.baseUrl = baseUrl;
    }

    public BankResult charge(BankChargeRequest request) {
        return call(() -> restTemplate.postForEntity(baseUrl + "/api/v1/bank/charge", request, BankResponse.class));
    }

    public BankResult enquire(String transactionId) {
        return call(() -> restTemplate.getForEntity(baseUrl + "/api/v1/bank/status?transaction_id={id}",
                BankResponse.class, transactionId));
    }

    public BankResult refund(BankRefundRequest request) {
        return call(() -> restTemplate.postForEntity(baseUrl + "/api/v1/bank/refund", request, BankResponse.class));
    }

    private BankResult call(Supplier<ResponseEntity<BankResponse>> request) {
        long start = System.nanoTime();
        try {
            ResponseEntity<BankResponse> response = request.get();
            int latency = elapsedMs(start);
            HttpStatusCode status = response.getStatusCode();
            BankResponse body = response.getBody();
            if (status.is5xxServerError() || body == null) {
                return new BankResult(BankResult.Outcome.UNAVAILABLE, body, latency, "HTTP " + status.value());
            }
            if (status.is2xxSuccessful() && body.getStatus() != null && APPROVED.contains(body.getStatus().toUpperCase(Locale.ROOT))) {
                return new BankResult(BankResult.Outcome.SUCCESS, body, latency, null);
            }
            return new BankResult(BankResult.Outcome.DECLINED, body, latency, body.getMessage());
        } catch (ResourceAccessException e) {
            // The request never reached the bank: failing over is safe. Anything else (read timeout,
            // connection reset) leaves the outcome unknown.
            Throwable cause = e.getCause();
            boolean notSent = cause instanceof ConnectException || cause instanceof UnknownHostException
                    || cause instanceof NoRouteToHostException;
            log.warn("Bank call failed ({}): {}", notSent ? "not sent" : "outcome unknown", e.getMessage());
            return new BankResult(notSent ? BankResult.Outcome.UNAVAILABLE : BankResult.Outcome.TIMEOUT,
                    null, elapsedMs(start), e.getMessage());
        } catch (RestClientException e) {
            // e.g. a plain-text error page that is not a bank response at all
            log.warn("Unexpected bank response: {}", e.getMessage());
            return new BankResult(BankResult.Outcome.UNAVAILABLE, null, elapsedMs(start), e.getMessage());
        }
    }

    private static int elapsedMs(long startNanos) {
        return (int) ((System.nanoTime() - startNanos) / 1_000_000);
    }
}
