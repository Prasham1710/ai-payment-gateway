package com.gateway.orchestrator.domain;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(name = "payments", indexes = {
    @Index(name = "idx_payment_merchant_created", columnList = "merchant_id, created_at"),
    @Index(name = "idx_payment_order", columnList = "order_id"),
    @Index(name = "idx_payment_idempotency", columnList = "merchant_id, idempotency_key", unique = true)
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Payment {

    @Id
    @Column(length = 64)
    private String id;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    @Column(name = "order_id", nullable = false, length = 64)
    private String orderId;

    /** In paise. */
    @Column(nullable = false)
    private long amount;

    @Column(length = 3, nullable = false)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private PaymentStatus status;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private PaymentMethod method;

    @Column(nullable = false)
    private boolean captured;

    @Column(name = "amount_refunded", nullable = false)
    private long amountRefunded;

    @Enumerated(EnumType.STRING)
    @Column(name = "refund_status", length = 10)
    private PaymentRefundStatus refundStatus;

    @Column(length = 100)
    private String vpa;

    /** Netbanking bank code, e.g. HDFC. */
    @Column(length = 10)
    private String bank;

    /** Only the last four digits and the network are kept; the full card number and CVV are never stored. */
    @Column(name = "card_last4", length = 4)
    private String cardLast4;

    @Column(name = "card_network", length = 20)
    private String cardNetwork;

    @Column(length = 254)
    private String email;

    @Column(length = 20)
    private String contact;

    /** Platform fee including GST, in paise. Set when the payment is captured. */
    private Long fee;

    /** GST portion of {@link #fee}, in paise. */
    private Long tax;

    /** Provider rail that processed the payment. */
    @Column(length = 30)
    private String provider;

    /** Our transaction id on the provider rail that processed the payment, used for refunds. */
    @Column(name = "provider_transaction_id", length = 64)
    private String providerTransactionId;

    @Column(name = "bank_reference", length = 64)
    private String bankReference;

    /** Number of provider rails tried while routing this payment. */
    @Column(nullable = false)
    private int attempts;

    @Column(name = "error_code", length = 40)
    private String errorCode;

    @Column(name = "error_description", length = 255)
    private String errorDescription;

    @Column(name = "error_source", length = 40)
    private String errorSource;

    @Column(name = "error_step", length = 60)
    private String errorStep;

    @Column(name = "error_reason", length = 60)
    private String errorReason;

    @Column(name = "idempotency_key", length = 64)
    private String idempotencyKey;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "captured_at")
    private Instant capturedAt;

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
