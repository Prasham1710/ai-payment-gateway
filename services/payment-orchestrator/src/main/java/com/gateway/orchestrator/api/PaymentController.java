package com.gateway.orchestrator.api;

import com.gateway.orchestrator.dto.PaymentRequest;
import com.gateway.orchestrator.dto.PaymentResponse;
import com.gateway.orchestrator.service.PaymentOrchestratorService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/payments")
@RequiredArgsConstructor
@CrossOrigin(origins = "*")
public class PaymentController {

    private final PaymentOrchestratorService paymentOrchestratorService;

    @PostMapping
    public ResponseEntity<PaymentResponse> initiatePayment(@RequestBody PaymentRequest request) {
        if (request.getMerchantId() == null || request.getMerchantId().isBlank()) {
            request.setMerchantId("merch_demo_101");
        }
        PaymentResponse response = paymentOrchestratorService.initiatePayment(request);
        return ResponseEntity.ok(response);
    }

    @GetMapping("/{paymentId}")
    public ResponseEntity<PaymentResponse> getPayment(@PathVariable String paymentId) {
        PaymentResponse response = paymentOrchestratorService.getPaymentById(paymentId);
        return ResponseEntity.ok(response);
    }

    @GetMapping("/merchant/{merchantId}")
    public ResponseEntity<List<PaymentResponse>> getMerchantPayments(@PathVariable String merchantId) {
        List<PaymentResponse> responses = paymentOrchestratorService.getPaymentsByMerchant(merchantId);
        return ResponseEntity.ok(responses);
    }
}
