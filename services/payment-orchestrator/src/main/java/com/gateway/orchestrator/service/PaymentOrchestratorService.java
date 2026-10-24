package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.Transaction;
import com.gateway.orchestrator.dto.BankChargeRequest;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.support.Ids;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

/**
 * Routes a payment authorization across the provider rails (Provider A -> Provider B -> Provider C).
 *
 * <p>Fails over to the next rail only when the current one definitely did not process the charge
 * (rail killed, 5xx, connection refused). A bank decline ends routing, because the customer's bank
 * said no and retrying elsewhere would just charge them again. A timeout is first resolved with a
 * status enquiry; if the outcome is still unknown, routing stops rather than risk a double charge.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentOrchestratorService {

    private final BankSimulatorClient bankClient;
    private final TransactionRepository transactionRepository;
    private final GatewayProperties properties;

    public RoutingResult authorize(Payment payment) {
        int attempts = 0;
        for (String providerId : properties.getRouting().getProviders()) {
            attempts++;
            String txId = Ids.newId("tx");
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

            if (result.outcome() == BankResult.Outcome.TIMEOUT) {
                BankResult enquiry = bankClient.enquire(txId);
                log.warn("Payment {} timed out on {}; status enquiry says {}", payment.getId(), providerId, enquiry.outcome());
                if (enquiry.outcome() == BankResult.Outcome.SUCCESS || enquiry.outcome() == BankResult.Outcome.DECLINED) {
                    result = new BankResult(enquiry.outcome(), enquiry.body(), result.latencyMs(), null);
                }
            }
            recordAttempt(payment, txId, providerId, result);

            switch (result.outcome()) {
                case SUCCESS -> {
                    log.info("Payment {} authorized via {}", payment.getId(), providerId);
                    return RoutingResult.authorized(providerId, txId, result.bankReference(), attempts);
                }
                case DECLINED -> {
                    log.info("Payment {} declined by bank on {}: {}", payment.getId(), providerId, result.message());
                    return RoutingResult.declined(providerId, result.responseCode(), result.message(), attempts);
                }
                case TIMEOUT -> {
                    return RoutingResult.timedOut(providerId, attempts);
                }
                case UNAVAILABLE -> log.warn("Provider {} unavailable for payment {}. Failing over.", providerId, payment.getId());
            }
        }
        log.error("Payment {} failed: all provider rails unavailable", payment.getId());
        return RoutingResult.allRailsUnavailable(attempts);
    }

    private void recordAttempt(Payment payment, String txId, String providerId, BankResult result) {
        AttemptStatus status = AttemptStatus.valueOf(result.outcome().name());
        String message = result.message();
        transactionRepository.save(Transaction.builder()
                .id(txId)
                .paymentId(payment.getId())
                .providerId(providerId)
                .amount(payment.getAmount())
                .status(status)
                .bankReference(status == AttemptStatus.SUCCESS ? result.bankReference() : null)
                .responseCode(result.responseCode())
                .message(message != null && message.length() > 255 ? message.substring(0, 255) : message)
                .latencyMs(result.latencyMs())
                .build());
    }
}
