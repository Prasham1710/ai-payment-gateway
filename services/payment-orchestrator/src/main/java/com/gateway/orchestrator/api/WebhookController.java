package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.CollectionResponse;
import com.gateway.orchestrator.dto.WebhookCreateRequest;
import com.gateway.orchestrator.dto.WebhookDeliveryResponse;
import com.gateway.orchestrator.dto.WebhookResponse;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.WebhookService;
import com.gateway.orchestrator.support.ListParams;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/webhooks")
@RequiredArgsConstructor
public class WebhookController {

    private final WebhookService webhookService;

    @PostMapping
    public ResponseEntity<WebhookResponse> create(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                  @RequestBody WebhookCreateRequest request) {
        return ResponseEntity.ok(webhookService.create(merchant, request));
    }

    @GetMapping
    public ResponseEntity<CollectionResponse<WebhookResponse>> list(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant) {
        return ResponseEntity.ok(CollectionResponse.of(webhookService.list(merchant)));
    }

    @GetMapping("/{webhookId}")
    public ResponseEntity<WebhookResponse> get(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                               @PathVariable String webhookId) {
        return ResponseEntity.ok(webhookService.get(merchant, webhookId));
    }

    @DeleteMapping("/{webhookId}")
    public ResponseEntity<Void> delete(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                       @PathVariable String webhookId) {
        webhookService.delete(merchant, webhookId);
        return ResponseEntity.noContent().build();
    }

    /** Most recent deliveries to this endpoint, with status, attempts and the receiver's last response. */
    @GetMapping("/{webhookId}/deliveries")
    public ResponseEntity<CollectionResponse<WebhookDeliveryResponse>> deliveries(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant,
                                                                                  @PathVariable String webhookId,
                                                                                  @RequestParam(required = false) Integer count) {
        int limit = ListParams.of(count, null, null, null).count();
        return ResponseEntity.ok(CollectionResponse.of(webhookService.deliveries(merchant, webhookId, limit)));
    }
}
