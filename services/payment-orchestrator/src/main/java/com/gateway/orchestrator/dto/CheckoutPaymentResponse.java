package com.gateway.orchestrator.dto;

import lombok.*;

/** Handed to the merchant's frontend; the merchant's server must verify {@code signature} before fulfilling. */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CheckoutPaymentResponse {
    private String paymentId;
    private String orderId;
    private String signature;
    private String status;
}
