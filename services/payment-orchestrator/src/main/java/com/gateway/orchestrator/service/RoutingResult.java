package com.gateway.orchestrator.service;

import com.gateway.orchestrator.exception.GatewayException;

/** Final outcome of routing one payment across the provider rails. */
public record RoutingResult(boolean authorized, String provider, String providerTransactionId, String bankReference,
                            int attempts, String errorCode, String errorDescription, String errorSource,
                            String errorStep, String errorReason) {

    private static final String STEP = "payment_authorization";

    public static RoutingResult authorized(String provider, String transactionId, String bankReference, int attempts) {
        return new RoutingResult(true, provider, transactionId, bankReference, attempts, null, null, null, null, null);
    }

    public static RoutingResult declined(String provider, String bankCode, String message, int attempts) {
        String reason = "51".equals(bankCode) ? "insufficient_funds" : "payment_declined";
        String description = message == null ? "Payment was declined by the bank." : message;
        return new RoutingResult(false, provider, null, null, attempts, GatewayException.BAD_REQUEST_ERROR,
                description, "bank", STEP, reason);
    }

    public static RoutingResult timedOut(String provider, int attempts) {
        return new RoutingResult(false, provider, null, null, attempts, GatewayException.GATEWAY_ERROR,
                "The bank did not respond in time. Any amount debited will be reversed automatically.",
                "bank", STEP, "bank_timeout");
    }

    public static RoutingResult allRailsUnavailable(int attempts) {
        return new RoutingResult(false, null, null, null, attempts, GatewayException.GATEWAY_ERROR,
                "Payment processing failed because all payment rails are currently unavailable.",
                "gateway", STEP, "all_providers_unavailable");
    }

    public static RoutingResult internalError(int attempts) {
        return new RoutingResult(false, null, null, null, attempts, GatewayException.SERVER_ERROR,
                "The payment could not be processed due to an internal error.", "gateway", STEP, "server_error");
    }
}
