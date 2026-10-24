package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.PaymentMethod;
import com.gateway.orchestrator.dto.CheckoutPaymentRequest;
import com.gateway.orchestrator.exception.GatewayException;
import org.junit.jupiter.api.Test;

import java.time.YearMonth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PaymentInstrumentTest {

    @Test
    void luhnCheck() {
        assertThat(PaymentInstrument.passesLuhn("4111111111111111")).isTrue();
        assertThat(PaymentInstrument.passesLuhn("5555555555554444")).isTrue();
        assertThat(PaymentInstrument.passesLuhn("4111111111111112")).isFalse();
    }

    @Test
    void detectsCardNetworks() {
        assertThat(PaymentInstrument.networkOf("4111111111111111")).isEqualTo("Visa");
        assertThat(PaymentInstrument.networkOf("5555555555554444")).isEqualTo("MasterCard");
        assertThat(PaymentInstrument.networkOf("2223003122003222")).isEqualTo("MasterCard");
        assertThat(PaymentInstrument.networkOf("378282246310005")).isEqualTo("American Express");
        assertThat(PaymentInstrument.networkOf("6074819900004939")).isEqualTo("RuPay");
    }

    @Test
    void keepsOnlyLastFourDigitsOfCard() {
        PaymentInstrument instrument = PaymentInstrument.from(card("4111 1111 1111 1111", 12, 2035, "123"));
        assertThat(instrument.method()).isEqualTo(PaymentMethod.CARD);
        assertThat(instrument.cardLast4()).isEqualTo("1111");
        assertThat(instrument.cardNetwork()).isEqualTo("Visa");
    }

    @Test
    void rejectsExpiredCardsAndBadCvv() {
        YearMonth lastMonth = YearMonth.now().minusMonths(1);
        assertThatThrownBy(() -> PaymentInstrument.from(card("4111111111111111", lastMonth.getMonthValue(), lastMonth.getYear(), "123")))
                .isInstanceOf(GatewayException.class)
                .hasMessageContaining("expired");
        assertThatThrownBy(() -> PaymentInstrument.from(card("4111111111111111", 12, 2035, "12")))
                .isInstanceOf(GatewayException.class)
                .hasMessageContaining("CVV");
        // American Express uses a 4-digit CVV.
        assertThat(PaymentInstrument.from(card("378282246310005", 12, 2035, "1234")).cardNetwork()).isEqualTo("American Express");
    }

    @Test
    void validatesUpiAndNetbanking() {
        CheckoutPaymentRequest upi = CheckoutPaymentRequest.builder().method("UPI").vpa(" Ravi.Kumar@OKAXIS ").build();
        assertThat(PaymentInstrument.from(upi).vpa()).isEqualTo("ravi.kumar@okaxis");

        CheckoutPaymentRequest badVpa = CheckoutPaymentRequest.builder().method("upi").vpa("not-a-vpa").build();
        assertThatThrownBy(() -> PaymentInstrument.from(badVpa)).isInstanceOf(GatewayException.class);

        CheckoutPaymentRequest netbanking = CheckoutPaymentRequest.builder().method("netbanking").bank("sbin").build();
        assertThat(PaymentInstrument.from(netbanking).bank()).isEqualTo("SBIN");
    }

    private static CheckoutPaymentRequest card(String number, int month, int year, String cvv) {
        return CheckoutPaymentRequest.builder()
                .method("card")
                .card(CheckoutPaymentRequest.CardDetails.builder()
                        .number(number).name("Ravi").expiryMonth(month).expiryYear(year).cvv(cvv).build())
                .build();
    }
}
