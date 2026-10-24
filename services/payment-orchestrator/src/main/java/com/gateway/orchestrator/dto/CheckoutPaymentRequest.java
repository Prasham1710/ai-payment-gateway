package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CheckoutPaymentRequest {
    /** The merchant's public API key id. */
    private String keyId;
    private String orderId;
    /** upi, card or netbanking. */
    private String method;
    private String vpa;
    /** Netbanking bank code, e.g. HDFC, ICIC, SBIN, UTIB, KKBK. */
    private String bank;
    private CardDetails card;
    private String email;
    private String contact;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class CardDetails {
        @ToString.Exclude
        private String number;
        private String name;
        private Integer expiryMonth;
        private Integer expiryYear;
        @ToString.Exclude
        private String cvv;
    }
}
