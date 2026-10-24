package com.gateway.orchestrator.domain;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

/** One call to one provider rail while routing a payment; a payment that failed over has several. */
@Entity
@Table(name = "transactions", indexes = {
    @Index(name = "idx_tx_payment", columnList = "payment_id"),
    @Index(name = "idx_tx_provider", columnList = "provider_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Transaction {

    @Id
    @Column(length = 64)
    private String id;

    @Column(name = "payment_id", nullable = false, length = 64)
    private String paymentId;

    @Column(name = "provider_id", nullable = false, length = 30)
    private String providerId;

    @Column(name = "bank_reference", length = 64)
    private String bankReference;

    /** In paise. */
    @Column(nullable = false)
    private long amount;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private AttemptStatus status;

    @Column(name = "response_code", length = 10)
    private String responseCode;

    @Column(length = 255)
    private String message;

    @Column(name = "latency_ms")
    private Integer latencyMs;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
