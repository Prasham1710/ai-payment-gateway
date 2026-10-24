package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.*;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.PaymentService;
import com.gateway.orchestrator.service.RefundService;
import com.gateway.orchestrator.support.ListParams;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/payments")
@RequiredArgsConstructor
public class PaymentController {

    private final PaymentService paymentService;
    private final RefundService refundService;

    @GetMapping
    public ResponseEntity<CollectionResponse<PaymentResponse>> list(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                    @RequestParam(required = false) Integer count,
                                                                    @RequestParam(required = false) Integer skip,
                                                                    @RequestParam(required = false) Long from,
                                                                    @RequestParam(required = false) Long to) {
        return ResponseEntity.ok(CollectionResponse.of(paymentService.list(merchant, ListParams.of(count, skip, from, to))));
    }

    @GetMapping("/{paymentId}")
    public ResponseEntity<PaymentResponse> get(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                               @PathVariable String paymentId) {
        return ResponseEntity.ok(paymentService.get(merchant, paymentId));
    }

    @PostMapping("/{paymentId}/capture")
    public ResponseEntity<PaymentResponse> capture(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                   @PathVariable String paymentId,
                                                   @RequestBody CaptureRequest request) {
        return ResponseEntity.ok(paymentService.capture(merchant, paymentId, request));
    }

    /** Every provider rail tried while routing the payment, in order (shows failover). */
    @GetMapping("/{paymentId}/attempts")
    public ResponseEntity<CollectionResponse<AttemptResponse>> attempts(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                        @PathVariable String paymentId) {
        return ResponseEntity.ok(CollectionResponse.of(paymentService.attempts(merchant, paymentId)));
    }

    @PostMapping("/{paymentId}/refund")
    public ResponseEntity<RefundResponse> refund(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                 @PathVariable String paymentId,
                                                 @RequestBody(required = false) RefundCreateRequest request,
                                                 @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        RefundCreateRequest body = request == null ? new RefundCreateRequest() : request;
        return ResponseEntity.ok(refundService.create(merchant, paymentId, body, idempotencyKey));
    }

    @GetMapping("/{paymentId}/refunds")
    public ResponseEntity<CollectionResponse<RefundResponse>> refunds(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                      @PathVariable String paymentId) {
        return ResponseEntity.ok(CollectionResponse.of(refundService.forPayment(merchant, paymentId)));
    }
}
