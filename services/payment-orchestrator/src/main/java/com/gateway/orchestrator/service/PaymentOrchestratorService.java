package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.Transaction;
import com.gateway.orchestrator.dto.BankChargeRequest;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.Text;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

/**
 * Routes a payment authorization across the provider rails, in the order suggested by the AI router
 * ({@link RoutingAdvisor}), or the configured order (Provider A -> Provider B -> Provider C) without it.
 *
 * <p>Fails over to the next rail only when the current one definitely did not process the charge
 * (rail killed / 503, connection refused, request rejected). A bank decline ends routing, because
 * the customer's bank said no and retrying elsewhere would just charge them again. Any other
 * failure (timeout, 502/504, unreadable answer) is first checked with a status enquiry; if the
 * outcome is still unknown, routing stops rather than risk a double charge, and
 * {@link PaymentReconciler} follows up later.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentOrchestratorService {

    private final BankSimulatorClient bankClient;
    private final TransactionRepository transactionRepository;
    private final RoutingAdvisor routingAdvisor;

    public RoutingResult authorize(Payment payment) {
        RoutingAdvisor.Plan plan = routingAdvisor.plan(payment);
        log.info("Routing payment {} ({}) in order {} [{}]", payment.getId(), payment.getMethod(), plan.providers(), plan.strategy());
        int attempts = 0;
        for (String providerId : plan.providers()) {
            attempts++;
            // Write-ahead: the attempt is committed as UNKNOWN before the charge is sent, so a crash or a
            // failed write while the bank is processing it still leaves a transaction id to reconcile.
            Transaction attempt = transactionRepository.save(Transaction.builder()
                    .id(Ids.newId("tx"))
                    .paymentId(payment.getId())
                    .providerId(providerId)
                    .amount(payment.getAmount())
                    .status(AttemptStatus.UNKNOWN)
                    .build());
            String txId = attempt.getId();
            log.info("Attempting payment {} via provider {} (attempt {})", payment.getId(), providerId, attempts);

            BankResult result = bankClient.charge(BankChargeRequest.builder()
                    .transactionId(txId)
                    .providerId(providerId)
                    .amount(BigDecimal.valueOf(payment.getAmount(), 2))
                    .currency(payment.getCurrency())
                    .paymentMethod(payment.getMethod().name())
                    .customerVpa(payment.getVpa())
                    .cardLast4(payment.getCardLast4())
                    .bankCode(payment.getBank())
                    .build());

            if (result.outcome() == BankResult.Outcome.UNKNOWN) {
                BankResult enquiry = bankClient.enquire(txId);
                log.warn("Payment {} got no usable answer from {}; status enquiry says {}", payment.getId(), providerId, enquiry.outcome());
                if (enquiry.outcome() == BankResult.Outcome.SUCCESS || enquiry.outcome() == BankResult.Outcome.DECLINED) {
                    result = new BankResult(enquiry.outcome(), enquiry.body(), result.latencyMs(), null);
                }
            }
            AttemptStatus attemptStatus = recordOutcome(attempt, result);
            routingAdvisor.feedback(providerId, payment, attemptStatus, result.latencyMs());

            switch (result.outcome()) {
                case SUCCESS -> {
                    log.info("Payment {} authorized via {}", payment.getId(), providerId);
                    return RoutingResult.authorized(providerId, txId, Text.truncate(result.bankReference(), 64), attempts);
                }
                case DECLINED -> {
                    log.info("Payment {} declined by bank on {}: {}", payment.getId(), providerId, result.message());
                    return RoutingResult.declined(providerId, result.responseCode(), result.message(), attempts);
                }
                case UNKNOWN -> {
                    return RoutingResult.unknownOutcome(providerId, attempts);
                }
                case UNAVAILABLE -> log.warn("Provider {} unavailable for payment {}. Failing over.", providerId, payment.getId());
            }
        }
        log.error("Payment {} failed: all provider rails unavailable", payment.getId());
        return RoutingResult.allRailsUnavailable(attempts);
    }

    private AttemptStatus recordOutcome(Transaction attempt, BankResult result) {
        AttemptStatus status = result.outcome() == BankResult.Outcome.NOT_FOUND
                ? AttemptStatus.UNKNOWN : AttemptStatus.valueOf(result.outcome().name());
        attempt.setStatus(status);
        attempt.setBankReference(status == AttemptStatus.SUCCESS ? Text.truncate(result.bankReference(), 64) : null);
        attempt.setResponseCode(Text.truncate(result.responseCode(), 10));
        attempt.setMessage(Text.truncate(result.message(), 255));
        attempt.setLatencyMs(result.latencyMs());
        transactionRepository.save(attempt);
        return status;
    }
}
