package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class RefundResponse {
    private String id;
    @Builder.Default
    private String entity = "refund";
    private long amount;
    private String currency;
    private String paymentId;
    private Map<String, String> notes;
    private String receipt;
    private Map<String, String> acquirerData;
    private String status;
    private String failureReason;
    private long createdAt;
}
