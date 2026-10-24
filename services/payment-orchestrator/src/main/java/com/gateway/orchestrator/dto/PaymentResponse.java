package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PaymentResponse {
    private String id;
    @Builder.Default
    private String entity = "payment";
    private long amount;
    private String currency;
    private String status;
    private String orderId;
    private String method;
    private long amountRefunded;
    private String refundStatus;
    private boolean captured;
    private CardInfo card;
    private String bank;
    private String vpa;
    private String email;
    private String contact;
    private Long fee;
    private Long tax;
    private String errorCode;
    private String errorDescription;
    private String errorSource;
    private String errorStep;
    private String errorReason;
    private Map<String, String> acquirerData;
    /** Provider rail that processed the payment and how many rails were tried. */
    private String provider;
    private int attempts;
    private long createdAt;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CardInfo {
        private String last4;
        private String network;
    }
}
