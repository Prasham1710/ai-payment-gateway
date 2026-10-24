package com.gateway.orchestrator.service;

import com.gateway.orchestrator.dto.BankResponse;

public record BankResult(Outcome outcome, BankResponse body, int latencyMs, String error) {

    public enum Outcome {
        /** Charge approved / refund processed. */
        SUCCESS,
        /** The bank processed the request and said no. */
        DECLINED,
        /** The rail did not process the request (down, 5xx, connection refused). */
        UNAVAILABLE,
        /** No answer in time; the request may or may not have been processed. */
        TIMEOUT
    }

    public String responseCode() {
        return body == null ? null : body.getResponseCode();
    }

    public String bankReference() {
        return body == null ? null : body.getBankReference();
    }

    public String message() {
        if (body != null && body.getMessage() != null) {
            return body.getMessage();
        }
        return error;
    }
}
