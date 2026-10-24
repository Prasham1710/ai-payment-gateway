package com.gateway.orchestrator.domain;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;

@Entity
@Table(name = "webhook_endpoints", indexes = {
    @Index(name = "idx_webhook_merchant", columnList = "merchant_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WebhookEndpoint {

    public static final String ALL_EVENTS = "*";

    @Id
    @Column(length = 64)
    private String id;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    @Column(nullable = false, length = 2048)
    private String url;

    @Column(name = "secret_encrypted", nullable = false, length = 255)
    private String secretEncrypted;

    /** Comma-separated event names, or {@code *} for every event. */
    @Column(nullable = false, length = 1000)
    private String events;

    @Column(nullable = false)
    private boolean active;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public List<String> getEventList() {
        return Arrays.asList(events.split(","));
    }

    public boolean subscribesTo(String event) {
        List<String> subscribed = getEventList();
        return subscribed.contains(ALL_EVENTS) || subscribed.contains(event);
    }

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
