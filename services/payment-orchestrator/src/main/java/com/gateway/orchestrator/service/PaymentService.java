package com.gateway.orchestrator.service;

import com.gateway.orchestrator.config.GatewayProperties;
import com.gateway.orchestrator.domain.*;
import com.gateway.orchestrator.dto.AttemptResponse;
import com.gateway.orchestrator.dto.CaptureRequest;
import com.gateway.orchestrator.dto.PaymentResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.OrderRepository;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.ListParams;
import com.gateway.orchestrator.support.Validators;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Payment state machine. Each method is one short database transaction; the slow provider calls
 * happen in between (see {@link CheckoutService}), so no row lock is held while a bank is responding.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentService {

    /**
     * A payment still in {@code created} after this long is treated as abandoned: it no longer blocks
     * its order, and {@link PaymentReconciler} settles it. Well above the worst-case routing time.
     */
    public static final Duration IN_FLIGHT_WINDOW = Duration.ofMinutes(2);

    private final PaymentRepository paymentRepository;
    private final OrderRepository orderRepository;
    private final TransactionRepository transactionRepository;
    private final WebhookService webhookService;
    private final FeeCalculator feeCalculator;
    private final GatewayProperties properties;

    public record PaymentStart(Payment payment, boolean replay) {
    }

    /** Creates the payment in {@code created} state against a locked order. Replays return the payment created earlier. */
    @Transactional
    public PaymentStart start(Merchant merchant, String orderId, PaymentInstrument instrument,
                              String email, String contact, String idempotencyKey) {
        if (orderId == null || orderId.isBlank()) {
            throw GatewayException.badRequest("The order_id field is required.", "order_id");
        }
        PaymentOrder order = orderRepository.findByIdForUpdate(orderId)
                .filter(o -> o.getMerchantId().equals(merchant.getId()))
                .orElseThrow(() -> GatewayException.notFound("The order_id provided does not exist"));

        if (idempotencyKey != null) {
            Optional<Payment> earlier = paymentRepository.findByMerchantIdAndIdempotencyKey(merchant.getId(), idempotencyKey);
            if (earlier.isPresent()) {
                if (!earlier.get().getOrderId().equals(orderId)) {
                    throw GatewayException.badRequest("This Idempotency-Key was already used for a different order.", "idempotency_key");
                }
                return new PaymentStart(earlier.get(), true);
            }
        }
        if (order.getStatus() == OrderStatus.PAID) {
            throw GatewayException.badRequest("Order has already been paid.", "order_id");
        }
        Instant now = Instant.now();
        if (paymentRepository.existsByOrderIdAndStatusAndCreatedAtAfter(orderId, PaymentStatus.CREATED, now.minus(IN_FLIGHT_WINDOW))) {
            throw GatewayException.conflict("Another payment for this order is already being processed.");
        }

        Payment payment = paymentRepository.save(Payment.builder()
                .id(Ids.newId("pay"))
                .merchantId(merchant.getId())
                .orderId(order.getId())
                .amount(order.getAmount())
                .currency(order.getCurrency())
                .status(PaymentStatus.CREATED)
                .method(instrument.method())
                .vpa(instrument.vpa())
                .bank(instrument.bank())
                .cardLast4(instrument.cardLast4())
                .cardNetwork(instrument.cardNetwork())
                .email(email)
                .contact(contact)
                .idempotencyKey(idempotencyKey)
                .build());

        order.setAttempts(order.getAttempts() + 1);
        order.setStatus(OrderStatus.ATTEMPTED);
        return new PaymentStart(payment, false);
    }

    /** Applies the routing outcome to a {@code created} payment: {@code authorized} (and maybe captured) or {@code failed}. */
    @Transactional
    public Payment completeAuthorization(String paymentId, RoutingResult result) {
        Payment payment = paymentRepository.findByIdForUpdate(paymentId).orElseThrow();
        if (payment.getStatus() != PaymentStatus.CREATED) {
            return payment;
        }
        PaymentOrder order = orderRepository.findByIdForUpdate(payment.getOrderId()).orElseThrow();
        payment.setAttempts(result.attempts());

        if (result.authorized()) {
            authorize(payment, order, result.provider(), result.providerTransactionId(), result.bankReference());
            return payment;
        }
        payment.setProvider(result.provider());
        payment.setStatus(PaymentStatus.FAILED);
        payment.setErrorCode(result.errorCode());
        payment.setErrorDescription(result.errorDescription());
        payment.setErrorSource(result.errorSource());
        payment.setErrorStep(result.errorStep());
        payment.setErrorReason(result.errorReason());
        if (result.needsReconciliation()) {
            payment.setReconcileUntil(Instant.now().plus(properties.getReconciliation().getWindow()));
        }
        webhookService.publish(payment.getMerchantId(), WebhookService.PAYMENT_FAILED, entities(payment, null));
        log.info("Payment {} failed: {}", payment.getId(), result.errorReason());
        return payment;
    }

    /**
     * Late authorization: the bank confirmed, after the fact, a charge we recorded as failed or never
     * finished. The payment becomes {@code authorized} and follows the normal path from there (auto
     * capture, or an automatic refund if the order was meanwhile paid by another payment).
     */
    @Transactional
    public boolean authorizeLate(String paymentId, String provider, String providerTransactionId, String bankReference) {
        Payment payment = paymentRepository.findByIdForUpdate(paymentId).orElseThrow();
        if (payment.getStatus() != PaymentStatus.CREATED && payment.getStatus() != PaymentStatus.FAILED) {
            return false;
        }
        PaymentOrder order = orderRepository.findByIdForUpdate(payment.getOrderId()).orElseThrow();
        log.warn("Late authorization of payment {} via {} (was {})", payment.getId(), provider, payment.getStatus());
        authorize(payment, order, provider, providerTransactionId, bankReference);
        return true;
    }

    /** Called by the reconciler when it could not settle a failed payment's outcome this round. */
    @Transactional
    public void updateReconciliation(String paymentId, boolean outcomeStillUnknown) {
        Payment payment = paymentRepository.findByIdForUpdate(paymentId).orElseThrow();
        if (payment.getStatus() != PaymentStatus.FAILED || payment.getReconcileUntil() == null) {
            return;
        }
        if (!outcomeStillUnknown) {
            payment.setReconcileUntil(null);
            log.info("Payment {} confirmed as failed by the bank", payment.getId());
        } else if (Instant.now().isAfter(payment.getReconcileUntil())) {
            payment.setReconcileUntil(null);
            log.error("Payment {}: the bank never confirmed the outcome; manual reconciliation required", payment.getId());
        }
    }

    @Transactional
    public PaymentResponse capture(Merchant merchant, String paymentId, CaptureRequest req) {
        long amount = Validators.requireAmount(req.getAmount(), "amount");
        String currency = Validators.currency(req.getCurrency());
        Payment payment = paymentRepository.findByIdForUpdate(paymentId)
                .filter(p -> p.getMerchantId().equals(merchant.getId()))
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));

        if (payment.isCaptured()) {
            throw GatewayException.badRequest("This payment has already been captured.");
        }
        if (payment.getStatus() != PaymentStatus.AUTHORIZED) {
            throw GatewayException.badRequest("Only payments which have been authorized and not yet captured can be captured.");
        }
        if (amount != payment.getAmount()) {
            throw GatewayException.badRequest("Capture amount must be equal to the amount authorized (" + payment.getAmount() + ").", "amount");
        }
        if (!currency.equals(payment.getCurrency())) {
            throw GatewayException.badRequest("Capture currency must match the payment currency.", "currency");
        }
        PaymentOrder order = orderRepository.findByIdForUpdate(payment.getOrderId()).orElseThrow();
        if (order.getStatus() == OrderStatus.PAID) {
            throw GatewayException.badRequest("The order has already been paid by another payment. This payment will be refunded automatically.");
        }
        capture(payment, order);
        return EntityMapper.toResponse(payment);
    }

    private void authorize(Payment payment, PaymentOrder order, String provider, String providerTransactionId, String bankReference) {
        payment.setStatus(PaymentStatus.AUTHORIZED);
        payment.setProvider(provider);
        payment.setProviderTransactionId(providerTransactionId);
        payment.setBankReference(bankReference);
        payment.setErrorCode(null);
        payment.setErrorDescription(null);
        payment.setErrorSource(null);
        payment.setErrorStep(null);
        payment.setErrorReason(null);
        payment.setReconcileUntil(null);
        webhookService.publish(payment.getMerchantId(), WebhookService.PAYMENT_AUTHORIZED, entities(payment, null));

        // An authorization on an order that another payment already paid stays authorized; the
        // refund sweeper (RefundService) then refunds it automatically.
        if (order.isPaymentCapture() && order.getStatus() != OrderStatus.PAID) {
            capture(payment, order);
        }
    }

    private void capture(Payment payment, PaymentOrder order) {
        FeeCalculator.Fee fee = feeCalculator.calculate(payment.getAmount());
        payment.setStatus(PaymentStatus.CAPTURED);
        payment.setCaptured(true);
        payment.setCapturedAt(Instant.now());
        payment.setFee(fee.total());
        payment.setTax(fee.tax());

        order.setAmountPaid(order.getAmountPaid() + payment.getAmount());
        order.setStatus(OrderStatus.PAID);

        webhookService.publish(payment.getMerchantId(), WebhookService.PAYMENT_CAPTURED, entities(payment, null));
        webhookService.publish(payment.getMerchantId(), WebhookService.ORDER_PAID, entities(payment, order));
        log.info("Payment {} captured (fee {} incl. tax {}); order {} paid", payment.getId(), fee.total(), fee.tax(), order.getId());
    }

    @Transactional(readOnly = true)
    public PaymentResponse get(Merchant merchant, String paymentId) {
        return EntityMapper.toResponse(require(merchant, paymentId));
    }

    @Transactional(readOnly = true)
    public List<PaymentResponse> list(Merchant merchant, ListParams params) {
        return paymentRepository.findByMerchantIdAndCreatedAtBetween(merchant.getId(), params.from(), params.to(), params.pageable())
                .stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<AttemptResponse> attempts(Merchant merchant, String paymentId) {
        Payment payment = require(merchant, paymentId);
        return transactionRepository.findByPaymentIdOrderByCreatedAtAsc(payment.getId()).stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    private Payment require(Merchant merchant, String paymentId) {
        return paymentRepository.findByIdAndMerchantId(paymentId, merchant.getId())
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));
    }

    private static Map<String, Object> entities(Payment payment, PaymentOrder order) {
        Map<String, Object> entities = new LinkedHashMap<>();
        entities.put("payment", EntityMapper.toResponse(payment));
        if (order != null) {
            entities.put("order", EntityMapper.toResponse(order));
        }
        return entities;
    }
}
