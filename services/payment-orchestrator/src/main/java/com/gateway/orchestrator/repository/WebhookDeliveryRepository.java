package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.DeliveryStatus;
import com.gateway.orchestrator.domain.WebhookDelivery;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface WebhookDeliveryRepository extends JpaRepository<WebhookDelivery, String> {
    @Query("select d.id from WebhookDelivery d where d.status = :status and d.nextAttemptAt <= :now order by d.nextAttemptAt")
    List<String> findDueIds(@Param("status") DeliveryStatus status, @Param("now") Instant now, Pageable pageable);

    List<WebhookDelivery> findByEndpointIdOrderByCreatedAtDesc(String endpointId, Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select d from WebhookDelivery d where d.id = :id")
    Optional<WebhookDelivery> findByIdForUpdate(@Param("id") String id);

    @Modifying
    @Query("update WebhookDelivery d set d.status = :failed, d.lastError = :reason "
            + "where d.endpointId = :endpointId and d.status = :pending")
    int failPending(@Param("endpointId") String endpointId, @Param("reason") String reason,
                    @Param("pending") DeliveryStatus pending, @Param("failed") DeliveryStatus failed);
}
