package com.gateway.orchestrator.support;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;

public final class Signatures {

    private static final String HMAC_SHA256 = "HmacSHA256";

    private Signatures() {
    }

    public static String hmacSha256Hex(byte[] payload, String secret) {
        try {
            Mac mac = Mac.getInstance(HMAC_SHA256);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_SHA256));
            return HexFormat.of().formatHex(mac.doFinal(payload));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", e);
        }
    }

    public static String hmacSha256Hex(String payload, String secret) {
        return hmacSha256Hex(payload.getBytes(StandardCharsets.UTF_8), secret);
    }

    /**
     * Signature handed to the merchant's frontend after a successful checkout. The merchant
     * recomputes it with their key secret to prove the payment result was not tampered with:
     * {@code hex(HMAC_SHA256(order_id + "|" + payment_id, key_secret))}.
     */
    public static String paymentSignature(String orderId, String paymentId, String keySecret) {
        return hmacSha256Hex(orderId + "|" + paymentId, keySecret);
    }

    public static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
