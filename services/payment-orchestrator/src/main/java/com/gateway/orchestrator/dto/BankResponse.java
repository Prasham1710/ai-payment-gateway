package com.gateway.orchestrator.dto;

import lombok.*;

/** Response of the bank simulator's charge, status-enquiry and refund endpoints. */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BankResponse {
    private String transactionId;
    private String refundId;
    private String providerId;
    /** SUCCESS / FAILED for charges, PROCESSED / FAILED for refunds. */
    private String status;
    private String bankReference;
    private String responseCode;
    private String message;
    private Integer latencyMs;
    private String timestamp;
}
