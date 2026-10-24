package com.gateway.orchestrator.domain;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(name = "merchants", indexes = {
    @Index(name = "idx_merchant_key_id", columnList = "key_id", unique = true),
    @Index(name = "idx_merchant_email", columnList = "email", unique = true)
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Merchant {

    @Id
    @Column(length = 64)
    private String id;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(nullable = false, length = 254)
    private String email;

    @Column(name = "key_id", nullable = false, length = 64)
    private String keyId;

    @Column(name = "key_secret_encrypted", nullable = false, length = 255)
    private String keySecretEncrypted;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    protected void onCreate() {
        this.createdAt = Instant.now();
    }
}
