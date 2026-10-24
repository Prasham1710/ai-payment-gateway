package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class AttemptResponse {
    private String id;
    @Builder.Default
    private String entity = "payment_attempt";
    private String provider;
    private String status;
    private String responseCode;
    private String message;
    private String bankReference;
    private Integer latencyMs;
    private long createdAt;
}
