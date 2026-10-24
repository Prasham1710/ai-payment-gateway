package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.PaymentStatus;
import com.gateway.orchestrator.domain.Transaction;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.support.Text;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;

/**
 * Settles payments whose outcome the checkout could not establish:
 * <ul>
 *   <li>{@code failed} payments where the bank gave no usable answer (timeout, 502/504) or an
 *       internal error hit after the charge was sent: the reconciler asks the bank again (status
 *       enquiry) until the reconciliation window ends;</li>
 *   <li>{@code created} payments whose checkout request died mid-flight (process crash).</li>
 * </ul>
 * A charge the bank confirms becomes a late authorization, so the customer is never debited for a
 * payment the gateway reports as failed: it is captured, or refunded if the order was paid otherwise.
 */
@Service
@Slf4j
public class PaymentReconciler {

    private final PaymentRepository paymentRepository;
    private final TransactionRepository transactionRepository;
    private final PaymentService paymentService;
    private final BankSimulatorClient bankClient;
    private final GatewayProperties properties;
    private final TransactionTemplate tx;

    public PaymentReconciler(PaymentRepository paymentRepository, TransactionRepository transactionRepository,
                             PaymentService paymentService, BankSimulatorClient bankClient,
                             GatewayProperties properties, PlatformTransactionManager transactionManager) {
        this.paymentRepository = paymentRepository;
        this.transactionRepository = transactionRepository;
        this.paymentService = paymentService;
        this.bankClient = bankClient;
        this.properties = properties;
        this.tx = new TransactionTemplate(transactionManager);
    }

    @Scheduled(fixedDelayString = "${gateway.reconciliation.poll-interval-ms:30000}")
    public void reconcileDue() {
        Instant now = Instant.now();
        Instant staleBefore = now.minus(PaymentService.IN_FLIGHT_WINDOW);
        List<String> due = tx.execute(status -> paymentRepository.findIdsToReconcile(now, PaymentStatus.CREATED, staleBefore,
                PageRequest.of(0, properties.getReconciliation().getBatchSize())));
        for (String paymentId : due) {
            try {
                reconcile(paymentId);
            } catch (RuntimeException e) {
                log.error("Reconciling payment {} failed", paymentId, e);
            }
        }
    }

    public void reconcile(String paymentId) {
        Payment payment = tx.execute(status -> paymentRepository.findById(paymentId).orElse(null));
        if (payment == null) {
            return;
        }
        boolean abandoned = payment.getStatus() == PaymentStatus.CREATED
                && payment.getCreatedAt().isBefore(Instant.now().minus(PaymentService.IN_FLIGHT_WINDOW));
        boolean awaitingBank = payment.getStatus() == PaymentStatus.FAILED && payment.getReconcileUntil() != null;
        if (!abandoned && !awaitingBank) {
            return;
        }

        List<Transaction> attempts = tx.execute(status -> transactionRepository.findByPaymentIdOrderByCreatedAtAsc(paymentId));
        Transaction approved = attempts.stream().filter(a -> a.getStatus() == AttemptStatus.SUCCESS).findFirst().orElse(null);
        boolean stillUnknown = false;
        for (Transaction attempt : attempts) {
            if (approved != null) {
                break;
            }
            if (attempt.getStatus() != AttemptStatus.UNKNOWN) {
                continue;
            }
            BankResult enquiry = bankClient.enquire(attempt.getId());
            boolean answered = enquiry.outcome() == BankResult.Outcome.SUCCESS || enquiry.outcome() == BankResult.Outcome.DECLINED;
            // "Not found" is only conclusive once the bank has had ample time to record the charge.
            boolean neverProcessed = enquiry.outcome() == BankResult.Outcome.NOT_FOUND
                    && attempt.getCreatedAt().isBefore(Instant.now().minus(PaymentService.IN_FLIGHT_WINDOW));
            if (answered || neverProcessed) {
                approved = tx.execute(status -> resolveAttempt(attempt.getId(), enquiry));
            } else {
                stillUnknown = true;
            }
        }

        if (approved != null) {
            paymentService.authorizeLate(paymentId, approved.getProviderId(), approved.getId(), approved.getBankReference());
        } else if (abandoned) {
            List<Transaction> resolved = tx.execute(status -> transactionRepository.findByPaymentIdOrderByCreatedAtAsc(paymentId));
            paymentService.completeAuthorization(paymentId, failureFor(resolved, stillUnknown));
        } else {
            paymentService.updateReconciliation(paymentId, stillUnknown);
        }
    }

    /** Records the bank's late answer on the attempt; returns the attempt if the bank approved it. */
    private Transaction resolveAttempt(String attemptId, BankResult enquiry) {
        Transaction attempt = transactionRepository.findByIdForUpdate(attemptId).orElseThrow();
        if (attempt.getStatus() != AttemptStatus.UNKNOWN) {
            return attempt.getStatus() == AttemptStatus.SUCCESS ? attempt : null;
        }
        boolean success = enquiry.outcome() == BankResult.Outcome.SUCCESS;
        attempt.setStatus(switch (enquiry.outcome()) {
            case SUCCESS -> AttemptStatus.SUCCESS;
            case DECLINED -> AttemptStatus.DECLINED;
            default -> AttemptStatus.UNAVAILABLE;   // the bank never received it
        });
        attempt.setResponseCode(Text.truncate(enquiry.responseCode(), 10));
        attempt.setMessage(Text.truncate(enquiry.message(), 255));
        if (success) {
            attempt.setBankReference(Text.truncate(enquiry.bankReference(), 64));
        }
        log.info("Attempt {} on {} resolved by status enquiry: {}", attempt.getId(), attempt.getProviderId(), attempt.getStatus());
        return success ? attempt : null;
    }

    /** How an abandoned checkout ends when no attempt was approved. */
    private static RoutingResult failureFor(List<Transaction> attempts, boolean stillUnknown) {
        Transaction last = attempts.isEmpty() ? null : attempts.get(attempts.size() - 1);
        if (stillUnknown) {
            return RoutingResult.unknownOutcome(last.getProviderId(), attempts.size());
        }
        if (last != null && last.getStatus() == AttemptStatus.DECLINED) {
            return RoutingResult.declined(last.getProviderId(), last.getResponseCode(), last.getMessage(), attempts.size());
        }
        return RoutingResult.internalError(attempts.size());
    }
}
