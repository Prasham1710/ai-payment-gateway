package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.PaymentMethod;
import com.gateway.orchestrator.dto.CheckoutPaymentRequest;
import com.gateway.orchestrator.exception.GatewayException;

import java.time.YearMonth;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The validated, storable part of what the customer entered at checkout. For cards only the last
 * four digits and the network survive validation; the full number and CVV are discarded.
 */
public record PaymentInstrument(PaymentMethod method, String vpa, String bank, String cardLast4, String cardNetwork) {

    public static final Map<String, String> NETBANKING_BANKS = Map.of(
            "HDFC", "HDFC Bank",
            "ICIC", "ICICI Bank",
            "SBIN", "State Bank of India",
            "UTIB", "Axis Bank",
            "KKBK", "Kotak Mahindra Bank");

    /** handle@psp; at most 97 characters, which fits the 100-character column. */
    private static final Pattern VPA = Pattern.compile("^[a-zA-Z0-9.\\-_]{2,64}@[a-zA-Z]{2,32}$");

    public static PaymentInstrument from(CheckoutPaymentRequest req) {
        if (req.getMethod() == null || req.getMethod().isBlank()) {
            throw GatewayException.badRequest("The method field is required.", "method");
        }
        return switch (req.getMethod().trim().toLowerCase(Locale.ROOT)) {
            case "upi" -> upi(req.getVpa());
            case "card" -> card(req.getCard());
            case "netbanking" -> netbanking(req.getBank());
            default -> throw GatewayException.badRequest("Invalid payment method. Use upi, card or netbanking.", "method");
        };
    }

    private static PaymentInstrument upi(String vpa) {
        if (vpa == null || !VPA.matcher(vpa.trim()).matches()) {
            throw GatewayException.badRequest("Invalid VPA. Please enter a valid UPI ID, e.g. name@bank.", "vpa");
        }
        return new PaymentInstrument(PaymentMethod.UPI, vpa.trim().toLowerCase(Locale.ROOT), null, null, null);
    }

    private static PaymentInstrument netbanking(String bank) {
        String code = bank == null ? "" : bank.trim().toUpperCase(Locale.ROOT);
        if (!NETBANKING_BANKS.containsKey(code)) {
            throw GatewayException.badRequest("Invalid bank code. Supported: " + String.join(", ", NETBANKING_BANKS.keySet()) + ".", "bank");
        }
        return new PaymentInstrument(PaymentMethod.NETBANKING, null, code, null, null);
    }

    private static PaymentInstrument card(CheckoutPaymentRequest.CardDetails card) {
        if (card == null) {
            throw GatewayException.badRequest("The card field is required for card payments.", "card");
        }
        String number = card.getNumber() == null ? "" : card.getNumber().replaceAll("[\\s-]", "");
        if (!number.matches("\\d{12,19}") || !passesLuhn(number)) {
            throw GatewayException.badRequest("The card number is invalid.", "card.number");
        }
        Integer month = card.getExpiryMonth();
        Integer year = card.getExpiryYear();
        if (month == null || month < 1 || month > 12 || year == null) {
            throw GatewayException.badRequest("The card expiry date is invalid.", "card.expiry_month");
        }
        int fullYear = year < 100 ? 2000 + year : year;
        if (year < 0 || fullYear > YearMonth.now().getYear() + 50) {
            throw GatewayException.badRequest("The card expiry date is invalid.", "card.expiry_year");
        }
        if (YearMonth.of(fullYear, month).isBefore(YearMonth.now())) {
            throw GatewayException.badRequest("The card has expired.", "card.expiry_year");
        }
        String network = networkOf(number);
        int cvvLength = "American Express".equals(network) ? 4 : 3;
        if (card.getCvv() == null || !card.getCvv().matches("\\d{" + cvvLength + "}")) {
            throw GatewayException.badRequest("The card CVV is invalid.", "card.cvv");
        }
        return new PaymentInstrument(PaymentMethod.CARD, null, null, number.substring(number.length() - 4), network);
    }

    static boolean passesLuhn(String digits) {
        int sum = 0;
        boolean doubleIt = false;
        for (int i = digits.length() - 1; i >= 0; i--) {
            int d = digits.charAt(i) - '0';
            if (doubleIt) {
                d *= 2;
                if (d > 9) {
                    d -= 9;
                }
            }
            sum += d;
            doubleIt = !doubleIt;
        }
        return sum % 10 == 0;
    }

    static String networkOf(String number) {
        int first2 = Integer.parseInt(number.substring(0, 2));
        int first4 = Integer.parseInt(number.substring(0, 4));
        if (number.startsWith("4")) {
            return "Visa";
        }
        if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) {
            return "MasterCard";
        }
        if (first2 == 34 || first2 == 37) {
            return "American Express";
        }
        if (first2 == 60 || first2 == 65 || first2 == 81 || first2 == 82 || number.startsWith("508")) {
            return "RuPay";
        }
        return "Unknown";
    }
}
