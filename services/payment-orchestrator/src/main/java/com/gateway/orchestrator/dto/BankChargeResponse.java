package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BankChargeResponse {
    private String transaction_id;
    private String provider_id;
    private String status; // SUCCESS, FAILED, TIMEOUT
    private String bank_reference;
    private String response_code;
    private String message;
    private Integer latency_ms;
    private String timestamp;
}
