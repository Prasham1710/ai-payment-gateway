package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WebhookDeliveryResponse {
    private String id;
    @Builder.Default
    private String entity = "webhook_delivery";
    private String eventId;
    private String event;
    private String status;
    private int attempts;
    private Integer lastResponseCode;
    private String lastError;
    private Long nextAttemptAt;
    private Long deliveredAt;
    private long createdAt;
}
