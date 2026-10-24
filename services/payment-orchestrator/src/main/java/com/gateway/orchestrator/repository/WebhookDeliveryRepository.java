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
    /**
     * Due pending deliveries, oldest first, but at most {@code perEndpoint} per endpoint, so one
     * endpoint's backlog cannot fill the batch and hide everyone else's deliveries.
     */
    @Query(value = "select id from (select d.id, d.next_attempt_at, row_number() over "
            + "(partition by d.endpoint_id order by d.next_attempt_at, d.id) as rank_in_endpoint "
            + "from webhook_deliveries d where d.status = 'PENDING' and d.next_attempt_at <= :now) ranked "
            + "where rank_in_endpoint <= :perEndpoint order by next_attempt_at, id limit :maxRows", nativeQuery = true)
    List<String> findDueIdsFairly(@Param("now") Instant now, @Param("perEndpoint") int perEndpoint,
                                  @Param("maxRows") int maxRows);

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
