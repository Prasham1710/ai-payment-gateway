package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.MerchantAnalyticsResponse;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.AnalyticsService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/analytics")
@RequiredArgsConstructor
public class AnalyticsController {

    private final AnalyticsService analyticsService;

    /** Totals across all of the authenticated merchant's payments. */
    @GetMapping
    public ResponseEntity<MerchantAnalyticsResponse> summary(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant) {
        return ResponseEntity.ok(analyticsService.summarize(merchant));
    }
}
