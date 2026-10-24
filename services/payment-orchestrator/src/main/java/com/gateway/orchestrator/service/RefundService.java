package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.*;
import com.gateway.orchestrator.dto.BankRefundRequest;
import com.gateway.orchestrator.dto.RefundCreateRequest;
import com.gateway.orchestrator.dto.RefundResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.OrderRepository;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.repository.RefundRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.ListParams;
import com.gateway.orchestrator.support.Text;
import com.gateway.orchestrator.support.Validators;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Refunds. A captured payment can be refunded in full or in parts; an authorized payment that was
 * never captured can only be refunded in full (the authorization is reversed, no fee is charged).
 *
 * <p>The refund amount is reserved on the payment when the refund is created, so concurrent
 * refunds can never exceed the payment amount, then sent to the provider rail that took the
 * payment. If that rail is down the refund stays {@code pending} and is retried in the background.
 * A refund the bank rejects is marked {@code failed} and its reservation released; a refund whose
 * outcome is unknown is never released on a guess (the bank de-duplicates retries by refund id).
 *
 * <p>Authorized payments that will never be captured (the order was paid by another payment, or
 * the capture window passed) are refunded automatically.
 */
@Service
@Slf4j
public class RefundService {

    private final RefundRepository refundRepository;
    private final PaymentRepository paymentRepository;
    private final OrderRepository orderRepository;
    private final BankSimulatorClient bankClient;
    private final WebhookService webhookService;
    private final GatewayProperties properties;
    private final TransactionTemplate tx;

    public RefundService(RefundRepository refundRepository, PaymentRepository paymentRepository, OrderRepository orderRepository,
                         BankSimulatorClient bankClient, WebhookService webhookService,
                         GatewayProperties properties, PlatformTransactionManager transactionManager) {
        this.refundRepository = refundRepository;
        this.paymentRepository = paymentRepository;
        this.orderRepository = orderRepository;
        this.bankClient = bankClient;
        this.webhookService = webhookService;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
    }

    private record RefundStart(String refundId, boolean replay) {
    }

    public RefundResponse create(Merchant merchant, String paymentId, RefundCreateRequest req, String idempotencyKey) {
        Validators.idempotencyKey(idempotencyKey);
        RefundStart start = tx.execute(status -> reserve(merchant, paymentId, req, idempotencyKey));
        if (!start.replay()) {
            attempt(start.refundId());
        }
        return tx.execute(status -> EntityMapper.toResponse(refundRepository.findById(start.refundId()).orElseThrow()));
    }

    /** Sends a pending refund to the bank and applies the outcome. Safe to call concurrently: the bank de-duplicates by refund id. */
    public void attempt(String refundId) {
        Refund refund = tx.execute(status -> refundRepository.findById(refundId).orElse(null));
        if (refund == null || refund.getStatus() != RefundStatus.PENDING) {
            return;
        }
        String providerTransactionId = tx.execute(status ->
                paymentRepository.findById(refund.getPaymentId()).map(Payment::getProviderTransactionId).orElse(null));
        BankResult result = bankClient.refund(BankRefundRequest.builder()
                .refundId(refund.getId())
                .transactionId(providerTransactionId)
                .providerId(refund.getProvider())
                .amount(BigDecimal.valueOf(refund.getAmount(), 2))
                .currency(refund.getCurrency())
                .build());
        tx.executeWithoutResult(status -> applyOutcome(refundId, result));
    }

    @Scheduled(fixedDelayString = "${gateway.refunds.poll-interval-ms:5000}")
    public void retryDueRefunds() {
        List<String> due = tx.execute(status -> refundRepository.findDueIds(RefundStatus.PENDING, Instant.now(),
                PageRequest.of(0, properties.getRefunds().getBatchSize())));
        for (String refundId : due) {
            try {
                attempt(refundId);
            } catch (RuntimeException e) {
                log.error("Refund {} retry failed", refundId, e);
            }
        }
    }

    /** Refunds authorized payments that can no longer be captured, so the customer's money is not held indefinitely. */
    @Scheduled(fixedDelayString = "${gateway.payments.auto-refund-poll-interval-ms:30000}")
    public void refundUncapturableAuthorizations() {
        Instant now = Instant.now();
        Instant capturedBefore = now.minus(properties.getPayments().getCaptureWindow());
        Instant failedRefundRetryBefore = now.minus(properties.getPayments().getAutoRefundRetryInterval());
        List<String> paymentIds = tx.execute(status -> paymentRepository.findUncapturableAuthorizations(
                PaymentStatus.AUTHORIZED, OrderStatus.PAID, capturedBefore, RefundStatus.FAILED, failedRefundRetryBefore,
                PageRequest.of(0, properties.getPayments().getBatchSize())));
        for (String paymentId : paymentIds) {
            try {
                String refundId = tx.execute(status -> reserveAutomaticRefund(paymentId, capturedBefore, failedRefundRetryBefore));
                if (refundId != null) {
                    attempt(refundId);
                }
            } catch (RuntimeException e) {
                log.error("Automatic refund of payment {} failed", paymentId, e);
            }
        }
    }

    public RefundResponse get(Merchant merchant, String refundId) {
        return tx.execute(status -> EntityMapper.toResponse(refundRepository.findByIdAndMerchantId(refundId, merchant.getId())
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"))));
    }

    public List<RefundResponse> list(Merchant merchant, ListParams params) {
        return tx.execute(status -> refundRepository
                .findByMerchantIdAndCreatedAtBetween(merchant.getId(), params.from(), params.to(), params.pageable())
                .stream()
                .map(EntityMapper::toResponse)
                .toList());
    }

    public List<RefundResponse> forPayment(Merchant merchant, String paymentId) {
        return tx.execute(status -> {
            Payment payment = paymentRepository.findByIdAndMerchantId(paymentId, merchant.getId())
                    .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));
            return refundRepository.findByPaymentIdOrderByCreatedAtAsc(payment.getId()).stream()
                    .map(EntityMapper::toResponse)
                    .toList();
        });
    }

    private RefundStart reserve(Merchant merchant, String paymentId, RefundCreateRequest req, String idempotencyKey) {
        Payment payment = paymentRepository.findByIdForUpdate(paymentId)
                .filter(p -> p.getMerchantId().equals(merchant.getId()))
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));

        if (idempotencyKey != null) {
            Optional<Refund> earlier = refundRepository.findByMerchantIdAndIdempotencyKey(merchant.getId(), idempotencyKey);
            if (earlier.isPresent()) {
                if (!earlier.get().getPaymentId().equals(paymentId)) {
                    throw GatewayException.badRequest("This Idempotency-Key was already used for a different payment.", "idempotency_key");
                }
                return new RefundStart(earlier.get().getId(), true);
            }
        }
        if (payment.getStatus() == PaymentStatus.REFUNDED) {
            throw GatewayException.badRequest("The payment has been fully refunded already.");
        }
        long amount;
        if (payment.getStatus() == PaymentStatus.AUTHORIZED) {
            // Not captured: the whole authorization is reversed.
            if (req.getAmount() != null && req.getAmount() != payment.getAmount()) {
                throw GatewayException.badRequest("A payment that has not been captured can only be refunded in full ("
                        + payment.getAmount() + ").", "amount");
            }
            amount = payment.getAmount();
        } else if (payment.getStatus() == PaymentStatus.CAPTURED) {
            long refundable = payment.getAmount() - payment.getAmountRefunded();
            amount = req.getAmount() == null ? refundable : Validators.requireAmount(req.getAmount(), "amount");
            if (amount > refundable) {
                throw GatewayException.badRequest("The refund amount exceeds the unrefunded amount of the payment (" + refundable + ").", "amount");
            }
        } else {
            throw GatewayException.badRequest("Only captured or authorized payments can be refunded. This payment is "
                    + EntityMapper.lower(payment.getStatus()) + ".");
        }

        Refund refund = reserve(payment, amount, Validators.receipt(req.getReceipt()), Validators.notes(req.getNotes()),
                idempotencyKey, Instant.now().plus(properties.getRefunds().getRetryBackoff()));
        return new RefundStart(refund.getId(), false);
    }

    private String reserveAutomaticRefund(String paymentId, Instant capturedBefore, Instant failedRefundRetryBefore) {
        Payment payment = paymentRepository.findByIdForUpdate(paymentId).orElseThrow();
        if (payment.getStatus() != PaymentStatus.AUTHORIZED
                || refundRepository.existsBlockingRefund(paymentId, RefundStatus.FAILED, failedRefundRetryBefore)) {
            return null;
        }
        boolean orderPaid = orderRepository.findById(payment.getOrderId())
                .map(order -> order.getStatus() == OrderStatus.PAID).orElse(false);
        if (!orderPaid && !payment.getCreatedAt().isBefore(capturedBefore)) {
            return null;
        }
        String reason = orderPaid ? "order_paid_by_another_payment" : "not_captured_within_capture_window";
        Refund refund = reserve(payment, payment.getAmount(), null, Map.of("reason", reason), null, Instant.now());
        log.info("Automatically refunding uncaptured payment {} ({})", paymentId, reason);
        return refund.getId();
    }

    /** Creates a pending refund and reserves its amount on the (locked) payment. */
    private Refund reserve(Payment payment, long amount, String receipt, Map<String, String> notes,
                           String idempotencyKey, Instant firstRetryAt) {
        Refund refund = refundRepository.save(Refund.builder()
                .id(Ids.newId("rfnd"))
                .merchantId(payment.getMerchantId())
                .paymentId(payment.getId())
                .amount(amount)
                .currency(payment.getCurrency())
                .status(RefundStatus.PENDING)
                .receipt(receipt)
                .notes(new LinkedHashMap<>(notes))
                .provider(payment.getProvider())
                .attempts(0)
                // For merchant refunds this leaves room for the inline attempt before the background retry may pick it up.
                .nextAttemptAt(firstRetryAt)
                .idempotencyKey(idempotencyKey)
                .build());

        payment.setAmountRefunded(payment.getAmountRefunded() + amount);
        updateRefundState(payment);
        webhookService.publish(payment.getMerchantId(), WebhookService.REFUND_CREATED, entities(refund, payment));
        log.info("Refund {} of {} created for payment {}", refund.getId(), amount, payment.getId());
        return refund;
    }

    private void applyOutcome(String refundId, BankResult result) {
        Refund refund = refundRepository.findByIdForUpdate(refundId).orElseThrow();
        if (refund.getStatus() != RefundStatus.PENDING) {
            return;
        }
        refund.setAttempts(refund.getAttempts() + 1);
        switch (result.outcome()) {
            case SUCCESS -> {
                refund.setStatus(RefundStatus.PROCESSED);
                refund.setArn(Text.truncate(result.bankReference(), 64));
                refund.setProcessedAt(Instant.now());
                refund.setFailureReason(null);
                Payment payment = paymentRepository.findById(refund.getPaymentId()).orElseThrow();
                webhookService.publish(refund.getMerchantId(), WebhookService.REFUND_PROCESSED, entities(refund, payment));
                log.info("Refund {} processed (ARN {})", refund.getId(), refund.getArn());
            }
            case DECLINED -> fail(refund, result.message() == null ? "Refund was rejected by the bank." : result.message());
            case UNAVAILABLE, UNKNOWN -> {
                if (result.outcome() == BankResult.Outcome.UNKNOWN) {
                    refund.setOutcomeUnknown(true);
                }
                if (refund.getAttempts() < properties.getRefunds().getMaxAttempts()) {
                    refund.setNextAttemptAt(Instant.now().plus(properties.getRefunds().getRetryBackoff()));
                    refund.setFailureReason("Bank unavailable; retry scheduled.");
                    log.warn("Refund {} could not reach the bank (attempt {}); will retry", refund.getId(), refund.getAttempts());
                } else if (refund.isOutcomeUnknown()) {
                    // The bank may already have paid this out: releasing the amount could refund it twice.
                    refund.setNextAttemptAt(Instant.now().plus(properties.getRefunds().getUnconfirmedRetryInterval()));
                    refund.setFailureReason("The bank has not confirmed this refund yet; still retrying.");
                    log.error("Refund {} still unconfirmed after {} attempts; needs attention", refund.getId(), refund.getAttempts());
                } else {
                    fail(refund, "The bank was unavailable for " + refund.getAttempts() + " attempts.");
                }
            }
        }
    }

    private void fail(Refund refund, String reason) {
        Payment payment = paymentRepository.findByIdForUpdate(refund.getPaymentId()).orElseThrow();
        payment.setAmountRefunded(payment.getAmountRefunded() - refund.getAmount());
        updateRefundState(payment);
        refund.setStatus(RefundStatus.FAILED);
        refund.setFailureReason(Text.truncate(reason, 255));
        webhookService.publish(refund.getMerchantId(), WebhookService.REFUND_FAILED, entities(refund, payment));
        log.warn("Refund {} failed: {}", refund.getId(), reason);
    }

    private static void updateRefundState(Payment payment) {
        if (payment.getAmountRefunded() <= 0) {
            payment.setRefundStatus(null);
            payment.setStatus(payment.isCaptured() ? PaymentStatus.CAPTURED : PaymentStatus.AUTHORIZED);
        } else if (payment.getAmountRefunded() < payment.getAmount()) {
            payment.setRefundStatus(PaymentRefundStatus.PARTIAL);
            payment.setStatus(PaymentStatus.CAPTURED);
        } else {
            payment.setRefundStatus(PaymentRefundStatus.FULL);
            payment.setStatus(PaymentStatus.REFUNDED);
        }
    }

    private static Map<String, Object> entities(Refund refund, Payment payment) {
        Map<String, Object> entities = new LinkedHashMap<>();
        entities.put("refund", EntityMapper.toResponse(refund));
        entities.put("payment", EntityMapper.toResponse(payment));
        return entities;
    }
}
