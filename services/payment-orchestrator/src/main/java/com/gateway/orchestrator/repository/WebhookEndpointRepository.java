package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.WebhookEndpoint;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface WebhookEndpointRepository extends JpaRepository<WebhookEndpoint, String> {
    Optional<WebhookEndpoint> findByIdAndMerchantId(String id, String merchantId);

    List<WebhookEndpoint> findByMerchantIdOrderByCreatedAtAsc(String merchantId);

    List<WebhookEndpoint> findByMerchantIdAndActiveTrue(String merchantId);

    long countByMerchantId(String merchantId);
}
