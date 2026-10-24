package com.gateway.orchestrator.api;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.MerchantCreateRequest;
import com.gateway.orchestrator.dto.MerchantResponse;
import com.gateway.orchestrator.security.ApiKeyAuthFilter;
import com.gateway.orchestrator.service.EntityMapper;
import com.gateway.orchestrator.service.MerchantService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/merchants")
@RequiredArgsConstructor
public class MerchantController {

    private final MerchantService merchantService;

    /** Sign up. Public: returns the new account's API key id and secret (the secret is shown only once). */
    @PostMapping
    public ResponseEntity<MerchantResponse> signup(@RequestBody MerchantCreateRequest request) {
        return ResponseEntity.ok(merchantService.signup(request));
    }

    @GetMapping("/me")
    public ResponseEntity<MerchantResponse> me(@RequestAttribute(ApiKeyAuthFilter.MERCHANT_ATTRIBUTE) Merchant merchant) {
        return ResponseEntity.ok(EntityMapper.toResponse(merchant));
    }
}
