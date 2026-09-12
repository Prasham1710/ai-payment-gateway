package com.gateway.orchestrator.dto;

import lombok.*;
import java.math.BigDecimal;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PaymentRequest {
    private String merchantId;
    private BigDecimal amount;
    private String currency;
    private String paymentMethod; // UPI, CARD, NETBANKING
    private String idempotencyKey;
    private String customerVpa;
}
