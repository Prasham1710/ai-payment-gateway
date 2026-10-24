package com.gateway.orchestrator.dto;

import lombok.*;

import java.math.BigDecimal;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BankRefundRequest {
    private String refundId;
    /** The provider transaction that captured the money. */
    private String transactionId;
    private String providerId;
    /** In rupees. */
    private BigDecimal amount;
    private String currency;
}
