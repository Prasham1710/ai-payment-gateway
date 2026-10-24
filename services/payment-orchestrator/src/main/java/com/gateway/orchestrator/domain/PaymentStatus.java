package com.gateway.orchestrator.domain;

/**
 * Razorpay payment lifecycle: {@code created -> authorized -> captured -> refunded}, or {@code failed}.
 * A partially refunded payment stays {@code captured}; it becomes {@code refunded} once fully refunded.
 */
public enum PaymentStatus {
    CREATED,
    AUTHORIZED,
    CAPTURED,
    REFUNDED,
    FAILED
}
