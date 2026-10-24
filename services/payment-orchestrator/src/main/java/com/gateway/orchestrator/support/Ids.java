package com.gateway.orchestrator.support;

import java.security.SecureRandom;

/** Razorpay-style public identifiers: {@code <prefix>_<14 base62 chars>}, e.g. {@code order_9A33XWu170gUtm}. */
public final class Ids {

    private static final char[] ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private Ids() {
    }

    public static String newId(String prefix) {
        return prefix + "_" + random(14);
    }

    public static String random(int length) {
        char[] chars = new char[length];
        for (int i = 0; i < length; i++) {
            chars[i] = ALPHABET[RANDOM.nextInt(ALPHABET.length)];
        }
        return new String(chars);
    }
}
