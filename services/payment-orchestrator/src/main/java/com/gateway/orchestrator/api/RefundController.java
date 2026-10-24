package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.CollectionResponse;
import com.gateway.orchestrator.dto.RefundResponse;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.RefundService;
import com.gateway.orchestrator.support.ListParams;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/refunds")
@RequiredArgsConstructor
public class RefundController {

    private final RefundService refundService;

    @GetMapping
    public ResponseEntity<CollectionResponse<RefundResponse>> list(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                   @RequestParam(required = false) Integer count,
                                                                   @RequestParam(required = false) Integer skip,
                                                                   @RequestParam(required = false) Long from,
                                                                   @RequestParam(required = false) Long to) {
        return ResponseEntity.ok(CollectionResponse.of(refundService.list(merchant, ListParams.of(count, skip, from, to))));
    }

    @GetMapping("/{refundId}")
    public ResponseEntity<RefundResponse> get(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                              @PathVariable String refundId) {
        return ResponseEntity.ok(refundService.get(merchant, refundId));
    }
}
