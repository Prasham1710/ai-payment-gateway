package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.Refund;
import com.gateway.orchestrator.domain.RefundStatus;
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
public interface RefundRepository extends JpaRepository<Refund, String> {
    Optional<Refund> findByIdAndMerchantId(String id, String merchantId);

    Optional<Refund> findByMerchantIdAndIdempotencyKey(String merchantId, String idempotencyKey);

    List<Refund> findByPaymentIdOrderByCreatedAtAsc(String paymentId);

    List<Refund> findByMerchantIdAndCreatedAtBetween(String merchantId, Instant from, Instant to, Pageable pageable);

    @Query("select r.id from Refund r where r.status = :status and r.nextAttemptAt <= :now order by r.nextAttemptAt")
    List<String> findDueIds(@Param("status") RefundStatus status, @Param("now") Instant now, Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Refund r where r.id = :id")
    Optional<Refund> findByIdForUpdate(@Param("id") String id);
}
