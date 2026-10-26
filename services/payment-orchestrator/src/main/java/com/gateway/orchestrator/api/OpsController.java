package com.gateway.orchestrator.api;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.dto.CircuitBreakerResponse;
import com.gateway.orchestrator.dto.CollectionResponse;
import com.gateway.orchestrator.exception.GatewayException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Operator endpoints for the operations dashboard: provider rail circuit breakers.
 *
 * <p>Not part of the merchant API and not authenticated, like the bank simulator's chaos controls:
 * expose them only on a trusted network.
 */
@RestController
@RequestMapping("/ops")
@RequiredArgsConstructor
public class OpsController {

    private final CircuitBreakerRegistry circuitBreakers;
    private final GatewayProperties properties;

    @GetMapping("/circuit-breakers")
    public ResponseEntity<CollectionResponse<CircuitBreakerResponse>> circuitBreakers() {
        List<CircuitBreakerResponse> items = properties.getRouting().getProviders().stream()
                .map(id -> toResponse(circuitBreakers.circuitBreaker(id)))
                .toList();
        return ResponseEntity.ok(CollectionResponse.of(items));
    }

    /** Closes a rail's breaker and clears its statistics, e.g. after the rail was restored. */
    @PostMapping("/circuit-breakers/{providerId}/reset")
    public ResponseEntity<CircuitBreakerResponse> reset(@PathVariable String providerId) {
        if (!properties.getRouting().getProviders().contains(providerId)) {
            throw GatewayException.notFound("No provider rail with id " + providerId);
        }
        CircuitBreaker breaker = circuitBreakers.circuitBreaker(providerId);
        breaker.reset();
        return ResponseEntity.ok(toResponse(breaker));
    }

    private static CircuitBreakerResponse toResponse(CircuitBreaker breaker) {
        CircuitBreaker.Metrics metrics = breaker.getMetrics();
        CircuitBreakerConfig config = breaker.getCircuitBreakerConfig();
        return CircuitBreakerResponse.builder()
                .providerId(breaker.getName())
                .state(breaker.getState().name())
                .failureRate(metrics.getFailureRate())
                .bufferedCalls(metrics.getNumberOfBufferedCalls())
                .failedCalls(metrics.getNumberOfFailedCalls())
                .successfulCalls(metrics.getNumberOfSuccessfulCalls())
                .notPermittedCalls(metrics.getNumberOfNotPermittedCalls())
                .failureRateThreshold(config.getFailureRateThreshold())
                .minimumNumberOfCalls(config.getMinimumNumberOfCalls())
                .waitDurationInOpenStateMs(config.getWaitIntervalFunctionInOpenState().apply(1))
                .build();
    }
}
