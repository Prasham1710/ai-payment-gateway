package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.List;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WebhookCreateRequest {
    private String url;
    /** Used to sign every delivery (X-Gateway-Signature). */
    @ToString.Exclude
    private String secret;
    /** Event names to subscribe to, or ["*"] for all events. */
    private List<String> events;
}
