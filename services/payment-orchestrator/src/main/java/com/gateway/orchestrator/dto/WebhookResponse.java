package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.List;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WebhookResponse {
    private String id;
    @Builder.Default
    private String entity = "webhook";
    private String url;
    private List<String> events;
    private boolean active;
    private long createdAt;
}
