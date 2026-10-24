package com.gateway.orchestrator.service;

import com.gateway.orchestrator.dto.BankResponse;

public record BankResult(Outcome outcome, BankResponse body, int latencyMs, String error) {

    public enum Outcome {
        /** Charge approved / refund processed. */
        SUCCESS,
        /** The bank processed the request and said no. */
        DECLINED,
        /** The rail definitely did not process the request (503, connection refused, request rejected). */
        UNAVAILABLE,
        /** No usable answer; the request may or may not have been processed. */
        UNKNOWN
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
