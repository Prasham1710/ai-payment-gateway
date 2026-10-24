package com.gateway.orchestrator.domain;

/** The payment's {@code refund_status}: absent until refunded, then {@code partial} or {@code full}. */
public enum PaymentRefundStatus {
    PARTIAL,
    FULL
}
