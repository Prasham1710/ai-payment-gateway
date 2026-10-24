package com.gateway.orchestrator.repository;

import com.gateway.orchestrator.domain.OrderStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.PaymentStatus;
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
public interface PaymentRepository extends JpaRepository<Payment, String> {
    Optional<Payment> findByIdAndMerchantId(String id, String merchantId);

    Optional<Payment> findByMerchantIdAndIdempotencyKey(String merchantId, String idempotencyKey);

    List<Payment> findByOrderIdOrderByCreatedAtAsc(String orderId);

    List<Payment> findByMerchantIdAndCreatedAtBetween(String merchantId, Instant from, Instant to, Pageable pageable);

    boolean existsByOrderIdAndStatusAndCreatedAtAfter(String orderId, PaymentStatus status, Instant createdAfter);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Payment p where p.id = :id")
    Optional<Payment> findByIdForUpdate(@Param("id") String id);

    /**
     * Payments with an unknown bank outcome that are due for another check, plus payments whose
     * checkout request died mid-flight. Ordered by next check, so the batch rotates.
     */
    @Query("select p.id from Payment p where (p.reconcileUntil is not null and p.reconcileAfter <= :now) "
            + "or (p.status = :created and p.createdAt < :staleBefore) order by p.reconcileAfter, p.createdAt")
    List<String> findIdsToReconcile(@Param("now") Instant now, @Param("created") PaymentStatus created,
                                    @Param("staleBefore") Instant staleBefore, Pageable pageable);

    /**
     * Authorized payments that will never be captured: their order was paid by another payment, or
     * the capture window has passed. Skips payments with a refund in progress or done, and payments
     * whose last refund failed recently (retried after a back-off).
     */
    @Query("select p.id from Payment p, PaymentOrder o where o.id = p.orderId and p.status = :authorized "
            + "and (o.status = :paid or p.createdAt < :capturedBefore) "
            + "and not exists (select r.id from Refund r where r.paymentId = p.id "
            + "and (r.status <> :failed or r.createdAt > :failedRefundRetryBefore)) order by p.createdAt")
    List<String> findUncapturableAuthorizations(@Param("authorized") PaymentStatus authorized, @Param("paid") OrderStatus paid,
                                                @Param("capturedBefore") Instant capturedBefore,
                                                @Param("failed") RefundStatus failed,
                                                @Param("failedRefundRetryBefore") Instant failedRefundRetryBefore,
                                                Pageable pageable);
}
