package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.DeliveryStatus;
import com.gateway.orchestrator.domain.WebhookEndpoint;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface WebhookEndpointRepository extends JpaRepository<WebhookEndpoint, String> {
    Optional<WebhookEndpoint> findByIdAndMerchantId(String id, String merchantId);

    List<WebhookEndpoint> findByMerchantIdOrderByCreatedAtAsc(String merchantId);

    List<WebhookEndpoint> findByMerchantIdAndActiveTrue(String merchantId);

    long countByMerchantId(String merchantId);

    /**
     * Active, not paused endpoints that have due deliveries and spare capacity, least recently
     * served first, so every endpoint gets its turn (round robin).
     */
    @Query("select e.id from WebhookEndpoint e where e.active = true "
            + "and (e.pausedUntil is null or e.pausedUntil <= :now) "
            + "and e.id not in :busyEndpoints and e.merchantId not in :busyMerchants "
            + "and exists (select d.id from WebhookDelivery d where d.endpointId = e.id "
            + "and d.status = :pending and d.nextAttemptAt <= :now) "
            + "order by e.lastClaimedAt asc nulls first, e.id")
    List<String> findDispatchable(@Param("now") Instant now, @Param("pending") DeliveryStatus pending,
                                  @Param("busyEndpoints") Collection<String> busyEndpoints,
                                  @Param("busyMerchants") Collection<String> busyMerchants, Pageable pageable);

    @Modifying
    @Query("update WebhookEndpoint e set e.lastClaimedAt = :now where e.id = :id")
    int markClaimed(@Param("id") String id, @Param("now") Instant now);

    @Modifying
    @Query("update WebhookEndpoint e set e.consecutiveFailures = 0, e.pausedUntil = null where e.id = :id")
    int markHealthy(@Param("id") String id);

    @Modifying
    @Query("update WebhookEndpoint e set e.consecutiveFailures = e.consecutiveFailures + 1, e.pausedUntil = :until where e.id = :id")
    int markFailing(@Param("id") String id, @Param("until") Instant until);
}
