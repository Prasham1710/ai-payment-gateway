package com.gateway.orchestrator.domain;

public enum PaymentStatus {
    INITIATED,
    ROUTING,
    PENDING,
    SUCCESS,
    FAILED,
    TIMEOUT
}
