package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.Transaction;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;

@Repository
public interface TransactionRepository extends JpaRepository<Transaction, String> {
    List<Transaction> findByPaymentIdOrderByCreatedAtAsc(String paymentId);
}
