package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.Transaction;
import com.gateway.orchestrator.dto.BankChargeRequest;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.Text;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.concurrent.TimeUnit;

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
 *
 * <p>Each rail has a circuit breaker. A rail that keeps failing (unavailable or no usable answer) has
 * its breaker opened and is skipped without sending the charge, which is always safe to fail over
 * from, until the breaker lets trial calls through again. Bank declines count as healthy responses:
 * the rail worked, the customer's bank said no.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentOrchestratorService {

    private final BankSimulatorClient bankClient;
    private final TransactionRepository transactionRepository;
    private final RoutingAdvisor routingAdvisor;
    private final CircuitBreakerRegistry circuitBreakers;
    private final GatewayProperties properties;

    /** Response code recorded for a rail skipped because its circuit breaker was open. */
    public static final String CIRCUIT_OPEN = "CB_OPEN";

    public RoutingResult authorize(Payment payment) {
        RoutingAdvisor.Plan plan = routingAdvisor.plan(payment);
        log.info("Routing payment {} ({}) in order {} [{}]", payment.getId(), payment.getMethod(), plan.providers(), plan.strategy());
        int attempts = 0;
        for (String providerId : plan.providers()) {
            attempts++;
            CircuitBreaker breaker = breakerFor(providerId);
            if (breaker != null && !breaker.tryAcquirePermission()) {
                // Nothing is sent to the bank, so failing over to the next rail cannot double charge.
                transactionRepository.save(Transaction.builder()
                        .id(Ids.newId("tx"))
                        .paymentId(payment.getId())
                        .providerId(providerId)
                        .amount(payment.getAmount())
                        .status(AttemptStatus.UNAVAILABLE)
                        .responseCode(CIRCUIT_OPEN)
                        .message("Circuit breaker open: rail skipped without sending the charge")
                        .latencyMs(0)
                        .build());
                log.warn("Circuit breaker for {} is {}; skipping it for payment {}", providerId, breaker.getState(), payment.getId());
                continue;
            }
            // Write-ahead: the attempt is committed as UNKNOWN before the charge is sent, so a crash or a
            // failed write while the bank is processing it still leaves a transaction id to reconcile.
            Transaction attempt;
            try {
                attempt = transactionRepository.save(Transaction.builder()
                        .id(Ids.newId("tx"))
                        .paymentId(payment.getId())
                        .providerId(providerId)
                        .amount(payment.getAmount())
                        .status(AttemptStatus.UNKNOWN)
                        .build());
            } catch (RuntimeException e) {
                if (breaker != null) {
                    breaker.releasePermission();   // nothing was sent; not the rail's fault
                }
                throw e;
            }
            String txId = attempt.getId();
            log.info("Attempting payment {} via provider {} (attempt {})", payment.getId(), providerId, attempts);

            long started = System.nanoTime();
            BankResult result;
            try {
                result = bankClient.charge(BankChargeRequest.builder()
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
            } catch (RuntimeException e) {
                if (breaker != null) {
                    breaker.onError(System.nanoTime() - started, TimeUnit.NANOSECONDS, e);
                }
                throw e;
            }
            recordHealth(breaker, result, System.nanoTime() - started);
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

    private CircuitBreaker breakerFor(String providerId) {
        return properties.getRouting().isCircuitBreakerEnabled() ? circuitBreakers.circuitBreaker(providerId) : null;
    }

    /** A rail that answered (approved or declined) is healthy; unavailable or no usable answer counts as a failure. */
    private static void recordHealth(CircuitBreaker breaker, BankResult result, long elapsedNanos) {
        if (breaker == null) {
            return;
        }
        switch (result.outcome()) {
            case SUCCESS, DECLINED -> breaker.onSuccess(elapsedNanos, TimeUnit.NANOSECONDS);
            default -> breaker.onError(elapsedNanos, TimeUnit.NANOSECONDS,
                    new RailFailureException("Rail answered " + result.outcome()));
        }
    }

    /** Recorded as the failure cause on a rail's circuit breaker. */
    static final class RailFailureException extends RuntimeException {
        RailFailureException(String message) {
            super(message, null, false, false);
        }
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
