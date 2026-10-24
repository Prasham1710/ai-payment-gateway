package com.gateway.orchestrator.domain;

/** Outcome of a single call to a provider rail while routing a payment. */
public enum AttemptStatus {
    /** The bank approved the charge. */
    SUCCESS,
    /** The bank declined the charge (e.g. insufficient funds). Never retried on another rail. */
    DECLINED,
    /** The rail was down or rejected the call before processing it. Safe to fail over. */
    UNAVAILABLE,
    /** No answer in time: the charge may or may not have gone through, so it is not retried elsewhere. */
    TIMEOUT
}
