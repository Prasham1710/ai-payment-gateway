package com.gateway.orchestrator.domain;

import com.gateway.orchestrator.support.NotesConverter;
import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;
import java.util.Map;

@Entity
@Table(name = "refunds", indexes = {
    @Index(name = "idx_refund_payment", columnList = "payment_id"),
    @Index(name = "idx_refund_merchant_created", columnList = "merchant_id, created_at"),
    @Index(name = "idx_refund_due", columnList = "status, next_attempt_at"),
    @Index(name = "idx_refund_idempotency", columnList = "merchant_id, idempotency_key", unique = true)
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Refund {

    @Id
    @Column(length = 64)
    private String id;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    @Column(name = "payment_id", nullable = false, length = 64)
    private String paymentId;

    /** In paise. */
    @Column(nullable = false)
    private long amount;

    @Column(length = 3, nullable = false)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private RefundStatus status;

    @Column(length = 40)
    private String receipt;

    @Convert(converter = NotesConverter.class)
    @Column(length = 8000)
    private Map<String, String> notes;

    @Column(length = 30)
    private String provider;

    /** Acquirer reference number (ARN) returned by the bank once processed. */
    @Column(length = 64)
    private String arn;

    @Column(nullable = false)
    private int attempts;

    /** Set once any attempt got no usable answer: the bank may have processed it, so it is never failed on a guess. */
    @Column(name = "outcome_unknown", nullable = false, columnDefinition = "boolean default false not null")
    private boolean outcomeUnknown;

    @Column(name = "next_attempt_at")
    private Instant nextAttemptAt;

    @Column(name = "failure_reason", length = 255)
    private String failureReason;

    @Column(name = "idempotency_key", length = 64)
    private String idempotencyKey;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "processed_at")
    private Instant processedAt;

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
