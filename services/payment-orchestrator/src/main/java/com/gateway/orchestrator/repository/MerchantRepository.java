package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.Merchant;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface MerchantRepository extends JpaRepository<Merchant, String> {
    Optional<Merchant> findByKeyId(String keyId);
    boolean existsByEmail(String email);
}
