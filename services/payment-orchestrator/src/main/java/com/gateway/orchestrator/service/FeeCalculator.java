package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Platform fee on captured payments, reported like Razorpay: {@code fee} includes GST, {@code tax} is the GST part. */
@Component
@RequiredArgsConstructor
public class FeeCalculator {

    private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);

    private final GatewayProperties properties;

    public Fee calculate(long amount) {
        long base = percentOf(amount, properties.getPricing().getFeePercent());
        long tax = percentOf(base, properties.getPricing().getGstPercent());
        return new Fee(base + tax, tax);
    }

    private static long percentOf(long amount, BigDecimal percent) {
        return BigDecimal.valueOf(amount).multiply(percent).divide(HUNDRED, 0, RoundingMode.HALF_UP).longValueExact();
    }

    public record Fee(long total, long tax) {
    }
}
