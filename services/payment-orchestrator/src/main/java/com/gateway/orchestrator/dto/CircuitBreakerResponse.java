package com.gateway.orchestrator.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/** State and recent statistics of one provider rail's circuit breaker. */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CircuitBreakerResponse {
    @Builder.Default
    private String entity = "circuit_breaker";
    private String providerId;
    /** CLOSED, OPEN, HALF_OPEN (or DISABLED / FORCED_OPEN when set manually). */
    private String state;
    /** Failure rate in percent over the sliding window, or -1 until enough calls were made. */
    private float failureRate;
    private int bufferedCalls;
    private int failedCalls;
    private int successfulCalls;
    private long notPermittedCalls;
    private float failureRateThreshold;
    private int minimumNumberOfCalls;
    private long waitDurationInOpenStateMs;
}
