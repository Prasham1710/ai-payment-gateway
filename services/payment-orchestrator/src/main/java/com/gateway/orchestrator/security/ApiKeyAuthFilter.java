package com.gateway.orchestrator.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.dto.ErrorResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.MerchantRepository;
import com.gateway.orchestrator.support.Signatures;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Optional;

/**
 * Authenticates merchant API calls with HTTP Basic auth, using the API key id as the username
 * and the key secret as the password (the same scheme Razorpay uses).
 *
 * <p>Not applied to merchant signup or to the {@code /v1/checkout/**} routes, which run in the
 * customer's browser and identify the merchant by the public key id alone.
 */
@Component
@RequiredArgsConstructor
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    public static final String MERCHANT_ATTRIBUTE = "gateway.merchant";

    private final MerchantRepository merchantRepository;
    private final SecretCipher secretCipher;
    private final ObjectMapper objectMapper;

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Servlet path + path info is the container-normalized path (no ";params", "..", "//"),
        // unlike the raw request URI, so the public routes cannot be spoofed.
        String path = request.getServletPath() + (request.getPathInfo() == null ? "" : request.getPathInfo());
        if (!path.startsWith("/v1/") || path.startsWith("/v1/checkout/")) {
            return true;
        }
        return path.equals("/v1/merchants") && "POST".equalsIgnoreCase(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Optional<Merchant> merchant = authenticate(request.getHeader(HttpHeaders.AUTHORIZATION));
        if (merchant.isEmpty()) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setHeader(HttpHeaders.WWW_AUTHENTICATE, "Basic realm=\"gateway\"");
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            objectMapper.writeValue(response.getOutputStream(), ErrorResponse.from(GatewayException.unauthorized()));
            return;
        }
        request.setAttribute(MERCHANT_ATTRIBUTE, merchant.get());
        chain.doFilter(request, response);
    }

    private Optional<Merchant> authenticate(String header) {
        if (header == null || !header.regionMatches(true, 0, "Basic ", 0, 6)) {
            return Optional.empty();
        }
        String credentials;
        try {
            credentials = new String(Base64.getDecoder().decode(header.substring(6).trim()), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        int separator = credentials.indexOf(':');
        if (separator <= 0) {
            return Optional.empty();
        }
        String keyId = credentials.substring(0, separator);
        String keySecret = credentials.substring(separator + 1);
        return merchantRepository.findByKeyId(keyId)
                .filter(m -> Signatures.constantTimeEquals(secretCipher.decrypt(m.getKeySecretEncrypted()), keySecret));
    }
}
