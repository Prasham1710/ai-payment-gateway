package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.*;
import com.gateway.orchestrator.dto.BankRefundRequest;
import com.gateway.orchestrator.dto.RefundCreateRequest;
import com.gateway.orchestrator.dto.RefundResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.repository.RefundRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.ListParams;
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
 * Full and partial refunds. The refund amount is reserved on the payment when the refund is
 * created (so concurrent refunds can never exceed the captured amount), then sent to the provider
 * rail that captured the payment. If that rail is down the refund stays {@code pending} and is
 * retried in the background; a refund the bank rejects is marked {@code failed} and its
 * reservation released.
 */
@Service
@Slf4j
public class RefundService {

    private final RefundRepository refundRepository;
    private final PaymentRepository paymentRepository;
    private final BankSimulatorClient bankClient;
    private final WebhookService webhookService;
    private final GatewayProperties properties;
    private final TransactionTemplate tx;

    public RefundService(RefundRepository refundRepository, PaymentRepository paymentRepository,
                         BankSimulatorClient bankClient, WebhookService webhookService,
                         GatewayProperties properties, PlatformTransactionManager transactionManager) {
        this.refundRepository = refundRepository;
        this.paymentRepository = paymentRepository;
        this.bankClient = bankClient;
        this.webhookService = webhookService;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
    }

    private record RefundStart(String refundId, boolean replay) {
    }

    public RefundResponse create(Merchant merchant, String paymentId, RefundCreateRequest req, String idempotencyKey) {
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
        if (!payment.isCaptured()) {
            throw GatewayException.badRequest("Only captured payments can be refunded. This payment is " + EntityMapper.lower(payment.getStatus()) + ".");
        }
        long refundable = payment.getAmount() - payment.getAmountRefunded();
        if (refundable <= 0) {
            throw GatewayException.badRequest("The payment has been fully refunded already.");
        }
        long amount = req.getAmount() == null ? refundable : Validators.requireAmount(req.getAmount(), "amount");
        if (amount > refundable) {
            throw GatewayException.badRequest("The refund amount exceeds the unrefunded amount of the payment (" + refundable + ").", "amount");
        }

        Refund refund = refundRepository.save(Refund.builder()
                .id(Ids.newId("rfnd"))
                .merchantId(merchant.getId())
                .paymentId(payment.getId())
                .amount(amount)
                .currency(payment.getCurrency())
                .status(RefundStatus.PENDING)
                .receipt(Validators.receipt(req.getReceipt()))
                .notes(new LinkedHashMap<>(Validators.notes(req.getNotes())))
                .provider(payment.getProvider())
                .attempts(0)
                // Leave room for the inline attempt before the background retry may pick it up.
                .nextAttemptAt(Instant.now().plus(properties.getRefunds().getRetryBackoff()))
                .idempotencyKey(idempotencyKey)
                .build());

        payment.setAmountRefunded(payment.getAmountRefunded() + amount);
        updateRefundState(payment);
        webhookService.publish(merchant.getId(), WebhookService.REFUND_CREATED, entities(refund, payment));
        log.info("Refund {} of {} created for payment {}", refund.getId(), amount, payment.getId());
        return new RefundStart(refund.getId(), false);
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
                refund.setArn(result.bankReference());
                refund.setProcessedAt(Instant.now());
                refund.setFailureReason(null);
                Payment payment = paymentRepository.findById(refund.getPaymentId()).orElseThrow();
                webhookService.publish(refund.getMerchantId(), WebhookService.REFUND_PROCESSED, entities(refund, payment));
                log.info("Refund {} processed (ARN {})", refund.getId(), refund.getArn());
            }
            case DECLINED -> fail(refund, result.message() == null ? "Refund was rejected by the bank." : result.message());
            case UNAVAILABLE, TIMEOUT -> {
                if (refund.getAttempts() >= properties.getRefunds().getMaxAttempts()) {
                    fail(refund, "The bank was unavailable for " + refund.getAttempts() + " attempts.");
                } else {
                    refund.setNextAttemptAt(Instant.now().plus(properties.getRefunds().getRetryBackoff()));
                    refund.setFailureReason("Bank unavailable; retry scheduled.");
                    log.warn("Refund {} could not reach the bank (attempt {}); will retry", refund.getId(), refund.getAttempts());
                }
            }
        }
    }

    private void fail(Refund refund, String reason) {
        Payment payment = paymentRepository.findByIdForUpdate(refund.getPaymentId()).orElseThrow();
        payment.setAmountRefunded(payment.getAmountRefunded() - refund.getAmount());
        updateRefundState(payment);
        refund.setStatus(RefundStatus.FAILED);
        refund.setFailureReason(reason);
        webhookService.publish(refund.getMerchantId(), WebhookService.REFUND_FAILED, entities(refund, payment));
        log.warn("Refund {} failed: {}", refund.getId(), reason);
    }

    private static void updateRefundState(Payment payment) {
        if (payment.getAmountRefunded() <= 0) {
            payment.setRefundStatus(null);
            payment.setStatus(PaymentStatus.CAPTURED);
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
