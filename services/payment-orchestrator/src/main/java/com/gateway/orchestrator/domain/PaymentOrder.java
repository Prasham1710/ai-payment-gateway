package com.gateway.orchestrator.domain;

import com.gateway.orchestrator.support.NotesConverter;
import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;
import java.util.Map;

/** An order is created by the merchant's server before checkout and fixes the amount the customer pays. */
@Entity
@Table(name = "orders", indexes = {
    @Index(name = "idx_order_merchant_created", columnList = "merchant_id, created_at")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PaymentOrder {

    @Id
    @Column(length = 64)
    private String id;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    /** In paise. */
    @Column(nullable = false)
    private long amount;

    @Column(name = "amount_paid", nullable = false)
    private long amountPaid;

    @Column(length = 3, nullable = false)
    private String currency;

    @Column(length = 40)
    private String receipt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private OrderStatus status;

    @Column(nullable = false)
    private int attempts;

    /** Capture payments automatically as soon as they are authorized. */
    @Column(name = "payment_capture", nullable = false)
    private boolean paymentCapture;

    @Convert(converter = NotesConverter.class)
    @Column(length = 8000)
    private Map<String, String> notes;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public long getAmountDue() {
        return amount - amountPaid;
    }

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
