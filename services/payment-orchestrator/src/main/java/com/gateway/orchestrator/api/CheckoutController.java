package com.gateway.orchestrator.api;

import com.gateway.orchestrator.dto.CheckoutOrderResponse;
import com.gateway.orchestrator.dto.CheckoutPaymentRequest;
import com.gateway.orchestrator.dto.CheckoutPaymentResponse;
import com.gateway.orchestrator.service.CheckoutService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Public endpoints used by the hosted checkout (checkout.js). They run in the customer's browser,
 * so they identify the merchant by the public key id only and never accept the key secret.
 */
@RestController
@RequestMapping("/v1/checkout")
@RequiredArgsConstructor
public class CheckoutController {

    private final CheckoutService checkoutService;

    @GetMapping("/orders/{orderId}")
    public ResponseEntity<CheckoutOrderResponse> order(@PathVariable String orderId,
                                                       @RequestParam("key_id") String keyId) {
        return ResponseEntity.ok(checkoutService.describeOrder(keyId, orderId));
    }

    @PostMapping("/payments")
    public ResponseEntity<CheckoutPaymentResponse> pay(@RequestBody CheckoutPaymentRequest request,
                                                       @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        return ResponseEntity.ok(checkoutService.pay(request, idempotencyKey));
    }
}
