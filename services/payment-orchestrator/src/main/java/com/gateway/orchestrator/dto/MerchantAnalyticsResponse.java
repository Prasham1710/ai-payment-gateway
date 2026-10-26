package com.gateway.orchestrator.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

/** Payment totals for one merchant. All amounts are in paise. */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class MerchantAnalyticsResponse {
    @Builder.Default
    private String entity = "analytics";
    private String currency;
    /** Every payment attempt, including failed and in-progress ones. */
    private long payments;
    /** Payments the bank approved (authorized, captured or refunded since). */
    private long successfulPayments;
    private long failedPayments;
    /** Successful payments as a percentage of finished ones (in-progress payments excluded). */
    private double successRate;
    /** Amount of successful payments. */
    private long grossVolume;
    private long capturedVolume;
    private long refundedVolume;
    /** Platform fees on captured payments, including GST (Razorpay convention). */
    private long fees;
    /** The GST part of {@code fees}. */
    private long taxes;
    /** Captured minus refunded minus fees: what the merchant is settled. */
    private long netSettlement;
    private long averagePaymentValue;
    private Map<String, Long> countByStatus;
    private Map<String, Long> countByMethod;
    /** Successful payments per provider rail. */
    private Map<String, Long> successfulByProvider;
}
