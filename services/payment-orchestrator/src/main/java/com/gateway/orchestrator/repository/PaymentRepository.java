package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.PaymentStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface PaymentRepository extends JpaRepository<Payment, String> {
    Optional<Payment> findByIdAndMerchantId(String id, String merchantId);

    Optional<Payment> findByMerchantIdAndIdempotencyKey(String merchantId, String idempotencyKey);

    List<Payment> findByOrderIdOrderByCreatedAtAsc(String orderId);

    List<Payment> findByMerchantIdAndCreatedAtBetween(String merchantId, Instant from, Instant to, Pageable pageable);

    boolean existsByOrderIdAndStatusAndCreatedAtAfter(String orderId, PaymentStatus status, Instant createdAfter);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Payment p where p.id = :id")
    Optional<Payment> findByIdForUpdate(@Param("id") String id);
}
