package com.gateway.orchestrator.domain;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

/**
 * Transactional outbox row: written in the same database transaction as the state change that
 * raised the event, then delivered (and retried) by the webhook dispatcher.
 */
@Entity
@Table(name = "webhook_deliveries", indexes = {
    @Index(name = "idx_delivery_due", columnList = "status, next_attempt_at"),
    @Index(name = "idx_delivery_endpoint", columnList = "endpoint_id, created_at"),
    @Index(name = "idx_delivery_endpoint_due", columnList = "endpoint_id, status, next_attempt_at")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WebhookDelivery {

    @Id
    @Column(length = 64)
    private String id;

    /** Shared by every endpoint receiving the same event, so receivers can de-duplicate. */
    @Column(name = "event_id", nullable = false, length = 64)
    private String eventId;

    @Column(name = "endpoint_id", nullable = false, length = 64)
    private String endpointId;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    @Column(nullable = false, length = 60)
    private String event;

    @Column(nullable = false, length = 16000)
    private String payload;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private DeliveryStatus status;

    @Column(nullable = false)
    private int attempts;

    @Column(name = "next_attempt_at")
    private Instant nextAttemptAt;

    @Column(name = "last_response_code")
    private Integer lastResponseCode;

    @Column(name = "last_error", length = 255)
    private String lastError;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "delivered_at")
    private Instant deliveredAt;

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
