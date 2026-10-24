package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.CollectionResponse;
import com.gateway.orchestrator.dto.OrderCreateRequest;
import com.gateway.orchestrator.dto.OrderResponse;
import com.gateway.orchestrator.dto.PaymentResponse;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.OrderService;
import com.gateway.orchestrator.support.ListParams;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    @PostMapping
    public ResponseEntity<OrderResponse> create(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                @RequestBody OrderCreateRequest request) {
        return ResponseEntity.ok(orderService.create(merchant, request));
    }

    @GetMapping
    public ResponseEntity<CollectionResponse<OrderResponse>> list(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                  @RequestParam(required = false) Integer count,
                                                                  @RequestParam(required = false) Integer skip,
                                                                  @RequestParam(required = false) Long from,
                                                                  @RequestParam(required = false) Long to) {
        return ResponseEntity.ok(CollectionResponse.of(orderService.list(merchant, ListParams.of(count, skip, from, to))));
    }

    @GetMapping("/{orderId}")
    public ResponseEntity<OrderResponse> get(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                             @PathVariable String orderId) {
        return ResponseEntity.ok(orderService.get(merchant, orderId));
    }

    @GetMapping("/{orderId}/payments")
    public ResponseEntity<CollectionResponse<PaymentResponse>> payments(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                       @PathVariable String orderId) {
        return ResponseEntity.ok(CollectionResponse.of(orderService.payments(merchant, orderId)));
    }
}
