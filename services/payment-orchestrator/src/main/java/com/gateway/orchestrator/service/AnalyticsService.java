package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.domain.PaymentStatus;
import com.gateway.orchestrator.dto.MerchantAnalyticsResponse;
import com.gateway.orchestrator.repository.PaymentRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.EnumSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

@Service
@RequiredArgsConstructor
public class AnalyticsService {

    /** Statuses of payments the bank approved. */
    private static final Set<PaymentStatus> SUCCESSFUL = EnumSet.of(PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED, PaymentStatus.REFUNDED);

    private final PaymentRepository paymentRepository;

    @Transactional(readOnly = true)
    public MerchantAnalyticsResponse summarize(Merchant merchant) {
        long payments = 0, successful = 0, failed = 0, inProgress = 0;
        long gross = 0, captured = 0, refunded = 0, fees = 0, taxes = 0;
        Map<String, Long> byStatus = new TreeMap<>();
        Map<String, Long> byMethod = new TreeMap<>();
        Map<String, Long> byProvider = new TreeMap<>();

        for (PaymentRepository.PaymentSummaryRow row : paymentRepository.summarizeByMerchant(merchant.getId())) {
            long count = row.getPayments();
            payments += count;
            byStatus.merge(lower(row.getStatus()), count, Long::sum);
            byMethod.merge(lower(row.getMethod()), count, Long::sum);
            if (row.getStatus() == PaymentStatus.FAILED) {
                failed += count;
            } else if (row.getStatus() == PaymentStatus.CREATED) {
                inProgress += count;
            }
            if (SUCCESSFUL.contains(row.getStatus())) {
                successful += count;
                gross += row.getAmount();
                byProvider.merge(row.getProvider() == null ? "unknown" : row.getProvider(), count, Long::sum);
            }
            captured += row.getCapturedAmount();
            refunded += row.getRefundedAmount();
            fees += row.getFees();
            taxes += row.getTaxes();
        }
        long finished = payments - inProgress;
        double successRate = finished == 0 ? 0 : Math.round(successful * 1000.0 / finished) / 10.0;
        return MerchantAnalyticsResponse.builder()
                .currency("INR")
                .payments(payments)
                .successfulPayments(successful)
                .failedPayments(failed)
                .successRate(successRate)
                .grossVolume(gross)
                .capturedVolume(captured)
                .refundedVolume(refunded)
                .fees(fees)
                .taxes(taxes)
                .netSettlement(captured - refunded - fees)
                .averagePaymentValue(successful == 0 ? 0 : Math.round((double) gross / successful))
                .countByStatus(byStatus)
                .countByMethod(byMethod)
                .successfulByProvider(byProvider)
                .build();
    }

    private static String lower(Enum<?> value) {
        return value == null ? "unknown" : value.name().toLowerCase(Locale.ROOT);
    }
}
