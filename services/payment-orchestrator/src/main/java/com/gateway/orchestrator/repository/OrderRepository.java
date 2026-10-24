package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.PaymentOrder;
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
public interface OrderRepository extends JpaRepository<PaymentOrder, String> {
    Optional<PaymentOrder> findByIdAndMerchantId(String id, String merchantId);

    List<PaymentOrder> findByMerchantIdAndCreatedAtBetween(String merchantId, Instant from, Instant to, Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from PaymentOrder o where o.id = :id")
    Optional<PaymentOrder> findByIdForUpdate(@Param("id") String id);
}
