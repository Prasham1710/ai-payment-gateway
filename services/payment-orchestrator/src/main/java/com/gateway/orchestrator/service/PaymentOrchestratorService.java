package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.*;
import com.gateway.orchestrator.dto.*;
import com.gateway.orchestrator.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestTemplate;

import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentOrchestratorService {

    private final PaymentRepository paymentRepository;
    private final TransactionRepository transactionRepository;

    @Value("${simulator.base-url:http://localhost:8081}")
    private String simulatorBaseUrl;

    private final RestTemplate restTemplate = new RestTemplate();

    @Transactional
    public PaymentResponse initiatePayment(PaymentRequest req) {
        log.info("Processing payment request for merchant: {}, amount: {}", req.getMerchantId(), req.getAmount());

        // 1. Idempotency Check
        if (req.getIdempotencyKey() != null && !req.getIdempotencyKey().isBlank()) {
            Optional<Payment> existing = paymentRepository.findByIdempotencyKey(req.getIdempotencyKey());
            if (existing.isPresent()) {
                log.info("Duplicate request detected for idempotency key: {}", req.getIdempotencyKey());
                return mapToResponse(existing.get());
            }
        }

        // 2. Create Payment in INITIATED state
        String paymentId = "pay_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        Payment payment = Payment.builder()
                .id(paymentId)
                .merchantId(req.getMerchantId())
                .amount(req.getAmount())
                .currency(req.getCurrency() != null ? req.getCurrency() : "INR")
                .paymentMethod(req.getPaymentMethod() != null ? req.getPaymentMethod() : "UPI")
                .idempotencyKey(req.getIdempotencyKey())
                .status(PaymentStatus.INITIATED)
                .build();

        payment = paymentRepository.save(payment);

        // 3. Transition to ROUTING
        payment.setStatus(PaymentStatus.ROUTING);
        payment = paymentRepository.save(payment);

        // 4. Provider Routing & Failover Chain (Provider A -> Provider B -> Provider C)
        List<String> providerChain = List.of("provider-a", "provider-b", "provider-c");
        boolean isSuccess = false;

        for (String providerId : providerChain) {
            log.info("Attempting payment {} via provider {}", paymentId, providerId);
            String txId = "tx_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);

            BankChargeRequest bankReq = BankChargeRequest.builder()
                    .transaction_id(txId)
                    .provider_id(providerId)
                    .amount(req.getAmount())
                    .currency(payment.getCurrency())
                    .payment_method(payment.getPaymentMethod())
                    .customer_vpa(req.getCustomerVpa())
                    .build();

            try {
                long startTime = System.currentTimeMillis();
                ResponseEntity<BankChargeResponse> bankRespEntity = restTemplate.postForEntity(
                        simulatorBaseUrl + "/api/v1/bank/charge",
                        bankReq,
                        BankChargeResponse.class
                );
                int latency = (int) (System.currentTimeMillis() - startTime);

                BankChargeResponse bankResp = bankRespEntity.getBody();

                // Log Transaction attempt
                Transaction tx = Transaction.builder()
                        .id(txId)
                        .paymentId(paymentId)
                        .providerId(providerId)
                        .amount(req.getAmount())
                        .bankReference(bankResp != null ? bankResp.getBank_reference() : null)
                        .responseCode(bankResp != null ? bankResp.getResponse_code() : "500")
                        .latencyMs(latency)
                        .status("SUCCESS".equalsIgnoreCase(bankResp != null ? bankResp.getStatus() : "") ? PaymentStatus.SUCCESS : PaymentStatus.FAILED)
                        .build();

                transactionRepository.save(tx);

                if (bankResp != null && "SUCCESS".equalsIgnoreCase(bankResp.getStatus())) {
                    payment.setStatus(PaymentStatus.SUCCESS);
                    payment.setSelectedProvider(providerId);
                    payment.setBankReference(bankResp.getBank_reference());
                    payment.setFailureReason(null);
                    payment = paymentRepository.save(payment);
                    isSuccess = true;
                    log.info("Payment {} SUCCESS via {}", paymentId, providerId);
                    break;
                } else {
                    log.warn("Payment {} FAILED on provider {}. Trying next route.", paymentId, providerId);
                }

            } catch (Exception e) {
                log.error("Exception calling provider {}: {}", providerId, e.getMessage());
                // Save failed transaction attempt
                Transaction tx = Transaction.builder()
                        .id(txId)
                        .paymentId(paymentId)
                        .providerId(providerId)
                        .amount(req.getAmount())
                        .status(PaymentStatus.FAILED)
                        .responseCode("503")
                        .latencyMs(0)
                        .build();
                transactionRepository.save(tx);
            }
        }

        if (!isSuccess) {
            payment.setStatus(PaymentStatus.FAILED);
            payment.setFailureReason("All available payment providers/rails failed or timed out.");
            payment = paymentRepository.save(payment);
            log.error("Payment {} FAILED on all provider rails.", paymentId);
        }

        return mapToResponse(payment);
    }

    public PaymentResponse getPaymentById(String paymentId) {
        Payment payment = paymentRepository.findById(paymentId)
                .orElseThrow(() -> new RuntimeException("Payment not found with id: " + paymentId));
        return mapToResponse(payment);
    }

    public List<PaymentResponse> getPaymentsByMerchant(String merchantId) {
        return paymentRepository.findByMerchantIdOrderByCreatedAtDesc(merchantId).stream()
                .map(this::mapToResponse)
                .toList();
    }

    private PaymentResponse mapToResponse(Payment p) {
        return PaymentResponse.builder()
                .id(p.getId())
                .merchantId(p.getMerchantId())
                .amount(p.getAmount())
                .currency(p.getCurrency())
                .status(p.getStatus())
                .paymentMethod(p.getPaymentMethod())
                .selectedProvider(p.getSelectedProvider())
                .bankReference(p.getBankReference())
                .failureReason(p.getFailureReason())
                .createdAt(p.getCreatedAt())
                .updatedAt(p.getUpdatedAt())
                .build();
    }
}
