package com.gateway.orchestrator.dto;

import lombok.*;

import java.math.BigDecimal;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BankChargeRequest {
    private String transactionId;
    private String providerId;
    /** In rupees, as the bank rails expect. */
    private BigDecimal amount;
    private String currency;
    private String paymentMethod;
    private String customerVpa;
    private String cardLast4;
    private String bankCode;
}
