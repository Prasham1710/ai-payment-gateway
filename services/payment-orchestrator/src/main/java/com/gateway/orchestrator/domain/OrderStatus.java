package com.gateway.orchestrator.domain;

/** {@code created} until the first payment attempt, {@code attempted} until a payment is captured, then {@code paid}. */
public enum OrderStatus {
    CREATED,
    ATTEMPTED,
    PAID
}
