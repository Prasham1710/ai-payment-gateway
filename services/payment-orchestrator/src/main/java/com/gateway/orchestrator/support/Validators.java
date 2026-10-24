package com.gateway.orchestrator.support;

import com.gateway.orchestrator.exception.GatewayException;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Request validation shared by the merchant APIs. Amounts are always in the smallest currency unit (paise). */
public final class Validators {

    public static final String CURRENCY_INR = "INR";
    public static final long MIN_AMOUNT = 100;                 // INR 1.00
    public static final long MAX_AMOUNT = 100_000_000_00L;     // INR 10 crore

    private static final int MAX_RECEIPT_LENGTH = 40;
    private static final int MAX_NOTES = 15;
    private static final int MAX_NOTE_LENGTH = 256;
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");
    private static final Pattern CONTACT = Pattern.compile("^\\+?[0-9]{8,15}$");

    private Validators() {
    }

    public static long requireAmount(Long amount, String field) {
        if (amount == null) {
            throw GatewayException.badRequest("The " + field + " field is required.", field);
        }
        if (amount < MIN_AMOUNT) {
            throw GatewayException.badRequest("The " + field + " must be at least INR 1.00 (100 paise).", field);
        }
        if (amount > MAX_AMOUNT) {
            throw GatewayException.badRequest("The " + field + " exceeds the maximum amount allowed.", field);
        }
        return amount;
    }

    public static String currency(String currency) {
        if (currency == null || currency.isBlank()) {
            return CURRENCY_INR;
        }
        String normalized = currency.trim().toUpperCase(Locale.ROOT);
        if (!CURRENCY_INR.equals(normalized)) {
            throw GatewayException.badRequest("Currency " + currency + " is not supported. Only INR is supported.", "currency");
        }
        return normalized;
    }

    public static String receipt(String receipt) {
        if (receipt != null && receipt.length() > MAX_RECEIPT_LENGTH) {
            throw GatewayException.badRequest("The receipt may not be greater than " + MAX_RECEIPT_LENGTH + " characters.", "receipt");
        }
        return receipt;
    }

    public static Map<String, String> notes(Map<String, String> notes) {
        if (notes == null) {
            return Map.of();
        }
        if (notes.size() > MAX_NOTES) {
            throw GatewayException.badRequest("Number of fields in notes should be less than or equal to " + MAX_NOTES + ".", "notes");
        }
        notes.forEach((key, value) -> {
            if (key.length() > MAX_NOTE_LENGTH || (value != null && value.length() > MAX_NOTE_LENGTH)) {
                throw GatewayException.badRequest("Notes keys and values may not be greater than " + MAX_NOTE_LENGTH + " characters.", "notes");
            }
        });
        return notes;
    }

    public static String email(String email, String field, boolean required) {
        if (email == null || email.isBlank()) {
            if (required) {
                throw GatewayException.badRequest("The " + field + " field is required.", field);
            }
            return null;
        }
        String trimmed = email.trim();
        if (trimmed.length() > 254 || !EMAIL.matcher(trimmed).matches()) {
            throw GatewayException.badRequest("The " + field + " must be a valid email address.", field);
        }
        return trimmed.toLowerCase(Locale.ROOT);
    }

    public static String contact(String contact) {
        if (contact == null || contact.isBlank()) {
            return null;
        }
        String compact = contact.replaceAll("[\\s-]", "");
        if (!CONTACT.matcher(compact).matches()) {
            throw GatewayException.badRequest("The contact must be a valid phone number.", "contact");
        }
        return compact;
    }
}
