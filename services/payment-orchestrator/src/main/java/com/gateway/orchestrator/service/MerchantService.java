package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.MerchantCreateRequest;
import com.gateway.orchestrator.dto.MerchantResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.MerchantRepository;
import com.gateway.orchestrator.security.SecretCipher;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.Validators;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class MerchantService {

    private static final String KEY_ID_PREFIX = "key_test_";

    private final MerchantRepository merchantRepository;
    private final SecretCipher secretCipher;

    /** Creates a merchant account with a test-mode API key pair. The key secret is only ever returned here. */
    @Transactional
    public MerchantResponse signup(MerchantCreateRequest req) {
        String name = req.getName() == null ? "" : req.getName().trim();
        if (name.isEmpty() || name.length() > 120) {
            throw GatewayException.badRequest("The name field is required and may not be greater than 120 characters.", "name");
        }
        String email = Validators.email(req.getEmail(), "email", true);
        if (merchantRepository.existsByEmail(email)) {
            throw GatewayException.badRequest("A merchant account with this email already exists.", "email");
        }

        String keySecret = Ids.random(24);
        Merchant merchant = merchantRepository.save(Merchant.builder()
                .id(Ids.newId("acc"))
                .name(name)
                .email(email)
                .keyId(KEY_ID_PREFIX + Ids.random(14))
                .keySecretEncrypted(secretCipher.encrypt(keySecret))
                .build());
        log.info("Merchant {} signed up with key {}", merchant.getId(), merchant.getKeyId());

        MerchantResponse response = EntityMapper.toResponse(merchant);
        response.setKeySecret(keySecret);
        return response;
    }

    /** Resolves the merchant behind a public key id (used by checkout, which never sees the secret). */
    @Transactional(readOnly = true)
    public Merchant requireByKeyId(String keyId) {
        if (keyId == null || keyId.isBlank()) {
            throw GatewayException.badRequest("The key_id field is required.", "key_id");
        }
        return merchantRepository.findByKeyId(keyId).orElseThrow(GatewayException::unauthorized);
    }

    public String keySecretOf(Merchant merchant) {
        return secretCipher.decrypt(merchant.getKeySecretEncrypted());
    }
}
