package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.Payment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.Optional;

@Repository
public interface PaymentRepository extends JpaRepository<Payment, String> {
    Optional<Payment> findByIdempotencyKey(String idempotencyKey);
    List<Payment> findByMerchantIdOrderByCreatedAtDesc(String merchantId);
}
