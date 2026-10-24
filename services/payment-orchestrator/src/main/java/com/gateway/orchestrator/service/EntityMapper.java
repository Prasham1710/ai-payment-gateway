package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.*;
import com.gateway.orchestrator.dto.*;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Maps entities to their public API shape: lower-case statuses, unix-second timestamps, paise amounts. */
public final class EntityMapper {

    private EntityMapper() {
    }

    public static MerchantResponse toResponse(Merchant m) {
        return MerchantResponse.builder()
                .id(m.getId())
                .name(m.getName())
                .email(m.getEmail())
                .keyId(m.getKeyId())
                .createdAt(m.getCreatedAt().getEpochSecond())
                .build();
    }

    public static OrderResponse toResponse(PaymentOrder o) {
        return OrderResponse.builder()
                .id(o.getId())
                .amount(o.getAmount())
                .amountPaid(o.getAmountPaid())
                .amountDue(o.getAmountDue())
                .currency(o.getCurrency())
                .receipt(o.getReceipt())
                .status(lower(o.getStatus()))
                .attempts(o.getAttempts())
                .notes(notes(o.getNotes()))
                .createdAt(o.getCreatedAt().getEpochSecond())
                .build();
    }

    public static PaymentResponse toResponse(Payment p) {
        Map<String, String> acquirerData = new LinkedHashMap<>();
        acquirerData.put("bank_reference", p.getBankReference());
        return PaymentResponse.builder()
                .id(p.getId())
                .amount(p.getAmount())
                .currency(p.getCurrency())
                .status(lower(p.getStatus()))
                .orderId(p.getOrderId())
                .method(lower(p.getMethod()))
                .amountRefunded(p.getAmountRefunded())
                .refundStatus(lower(p.getRefundStatus()))
                .captured(p.isCaptured())
                .card(p.getCardLast4() == null ? null : new PaymentResponse.CardInfo(p.getCardLast4(), p.getCardNetwork()))
                .bank(p.getBank())
                .vpa(p.getVpa())
                .email(p.getEmail())
                .contact(p.getContact())
                .fee(p.getFee())
                .tax(p.getTax())
                .errorCode(p.getErrorCode())
                .errorDescription(p.getErrorDescription())
                .errorSource(p.getErrorSource())
                .errorStep(p.getErrorStep())
                .errorReason(p.getErrorReason())
                .acquirerData(acquirerData)
                .provider(p.getProvider())
                .attempts(p.getAttempts())
                .createdAt(p.getCreatedAt().getEpochSecond())
                .build();
    }

    public static AttemptResponse toResponse(Transaction t) {
        return AttemptResponse.builder()
                .id(t.getId())
                .provider(t.getProviderId())
                .status(lower(t.getStatus()))
                .responseCode(t.getResponseCode())
                .message(t.getMessage())
                .bankReference(t.getBankReference())
                .latencyMs(t.getLatencyMs())
                .createdAt(t.getCreatedAt().getEpochSecond())
                .build();
    }

    public static RefundResponse toResponse(Refund r) {
        Map<String, String> acquirerData = new LinkedHashMap<>();
        acquirerData.put("arn", r.getArn());
        return RefundResponse.builder()
                .id(r.getId())
                .amount(r.getAmount())
                .currency(r.getCurrency())
                .paymentId(r.getPaymentId())
                .notes(notes(r.getNotes()))
                .receipt(r.getReceipt())
                .acquirerData(acquirerData)
                .status(lower(r.getStatus()))
                .failureReason(r.getFailureReason())
                .createdAt(r.getCreatedAt().getEpochSecond())
                .build();
    }

    public static WebhookResponse toResponse(WebhookEndpoint w) {
        return WebhookResponse.builder()
                .id(w.getId())
                .url(w.getUrl())
                .events(w.getEventList())
                .active(w.isActive())
                .createdAt(w.getCreatedAt().getEpochSecond())
                .build();
    }

    public static WebhookDeliveryResponse toResponse(WebhookDelivery d) {
        return WebhookDeliveryResponse.builder()
                .id(d.getId())
                .eventId(d.getEventId())
                .event(d.getEvent())
                .status(lower(d.getStatus()))
                .attempts(d.getAttempts())
                .lastResponseCode(d.getLastResponseCode())
                .lastError(d.getLastError())
                .nextAttemptAt(d.getStatus() == DeliveryStatus.PENDING ? epochSeconds(d.getNextAttemptAt()) : null)
                .deliveredAt(epochSeconds(d.getDeliveredAt()))
                .createdAt(d.getCreatedAt().getEpochSecond())
                .build();
    }

    static String lower(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }

    private static Long epochSeconds(Instant instant) {
        return instant == null ? null : instant.getEpochSecond();
    }

    private static Map<String, String> notes(Map<String, String> notes) {
        return notes == null ? Map.of() : notes;
    }
}
