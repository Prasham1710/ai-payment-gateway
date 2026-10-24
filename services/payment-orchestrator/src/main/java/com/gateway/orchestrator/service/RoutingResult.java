package com.gateway.orchestrator.service;

import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.support.Text;

/** Final outcome of routing one payment across the provider rails. */
public record RoutingResult(boolean authorized, String provider, String providerTransactionId, String bankReference,
                            int attempts, String errorCode, String errorDescription, String errorSource,
                            String errorStep, String errorReason) {

    public static final String REASON_OUTCOME_UNKNOWN = "bank_outcome_unknown";
    public static final String REASON_SERVER_ERROR = "server_error";

    private static final String STEP = "payment_authorization";

    public static RoutingResult authorized(String provider, String transactionId, String bankReference, int attempts) {
        return new RoutingResult(true, provider, transactionId, bankReference, attempts, null, null, null, null, null);
    }

    public static RoutingResult declined(String provider, String bankCode, String message, int attempts) {
        String reason = "51".equals(bankCode) ? "insufficient_funds" : "payment_declined";
        String description = message == null ? "Payment was declined by the bank." : Text.truncate(message, 255);
        return new RoutingResult(false, provider, null, null, attempts, GatewayException.BAD_REQUEST_ERROR,
                description, "bank", STEP, reason);
    }

    /** The bank never gave a usable answer, so the payment is reconciled later by status enquiry. */
    public static RoutingResult unknownOutcome(String provider, int attempts) {
        return new RoutingResult(false, provider, null, null, attempts, GatewayException.GATEWAY_ERROR,
                "The bank did not confirm this payment. If any amount was debited, it will be confirmed or refunded automatically.",
                "bank", STEP, REASON_OUTCOME_UNKNOWN);
    }

    public static RoutingResult allRailsUnavailable(int attempts) {
        return new RoutingResult(false, null, null, null, attempts, GatewayException.GATEWAY_ERROR,
                "Payment processing failed because all payment rails are currently unavailable.",
                "gateway", STEP, "all_providers_unavailable");
    }

    public static RoutingResult internalError(int attempts) {
        return new RoutingResult(false, null, null, null, attempts, GatewayException.SERVER_ERROR,
                "The payment could not be processed due to an internal error.", "gateway", STEP, REASON_SERVER_ERROR);
    }

    /** Failures where the bank may still have charged the customer, so the reconciler must follow up. */
    public boolean needsReconciliation() {
        return !authorized && (REASON_OUTCOME_UNKNOWN.equals(errorReason) || REASON_SERVER_ERROR.equals(errorReason));
    }
}
