package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.PaymentOrder;
import com.gateway.orchestrator.domain.PaymentStatus;
import com.gateway.orchestrator.dto.CheckoutOrderResponse;
import com.gateway.orchestrator.dto.CheckoutPaymentRequest;
import com.gateway.orchestrator.dto.CheckoutPaymentResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.OrderRepository;
import com.gateway.orchestrator.support.Signatures;
import com.gateway.orchestrator.support.Validators;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Customer-facing payment flow behind the hosted checkout. Authenticated only by the merchant's
 * public key id; the result carries a signature the merchant verifies with their key secret.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class CheckoutService {

    private static final int MAX_IDEMPOTENCY_KEY_LENGTH = 64;

    private final MerchantService merchantService;
    private final OrderRepository orderRepository;
    private final PaymentService paymentService;
    private final PaymentOrchestratorService orchestrator;

    @Transactional(readOnly = true)
    public CheckoutOrderResponse describeOrder(String keyId, String orderId) {
        Merchant merchant = merchantService.requireByKeyId(keyId);
        PaymentOrder order = orderRepository.findByIdAndMerchantId(orderId, merchant.getId())
                .orElseThrow(() -> GatewayException.notFound("The order_id provided does not exist"));
        return CheckoutOrderResponse.builder()
                .orderId(order.getId())
                .amount(order.getAmount())
                .currency(order.getCurrency())
                .status(EntityMapper.lower(order.getStatus()))
                .merchantName(merchant.getName())
                .build();
    }

    public CheckoutPaymentResponse pay(CheckoutPaymentRequest req, String idempotencyKey) {
        Merchant merchant = merchantService.requireByKeyId(req.getKeyId());
        if (idempotencyKey != null && (idempotencyKey.isBlank() || idempotencyKey.length() > MAX_IDEMPOTENCY_KEY_LENGTH)) {
            throw GatewayException.badRequest("Idempotency-Key must be 1 to " + MAX_IDEMPOTENCY_KEY_LENGTH + " characters.", "idempotency_key");
        }
        PaymentInstrument instrument = PaymentInstrument.from(req);
        String email = Validators.email(req.getEmail(), "email", false);
        String contact = Validators.contact(req.getContact());

        PaymentService.PaymentStart start = paymentService.start(merchant, req.getOrderId(), instrument, email, contact, idempotencyKey);
        Payment payment = start.payment();
        if (start.replay()) {
            if (payment.getStatus() == PaymentStatus.CREATED) {
                throw GatewayException.conflict("A payment with this Idempotency-Key is still being processed.");
            }
        } else {
            RoutingResult result;
            try {
                result = orchestrator.authorize(payment);
            } catch (RuntimeException e) {
                log.error("Routing payment {} failed unexpectedly", payment.getId(), e);
                result = RoutingResult.internalError(payment.getAttempts());
            }
            payment = paymentService.completeAuthorization(payment.getId(), result);
        }
        return toResult(merchant, payment);
    }

    private CheckoutPaymentResponse toResult(Merchant merchant, Payment payment) {
        if (payment.getStatus() == PaymentStatus.FAILED) {
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("payment_id", payment.getId());
            metadata.put("order_id", payment.getOrderId());
            HttpStatus status = GatewayException.BAD_REQUEST_ERROR.equals(payment.getErrorCode())
                    ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
            throw new GatewayException(status, payment.getErrorCode(), payment.getErrorDescription(), null,
                    payment.getErrorSource(), payment.getErrorStep(), payment.getErrorReason(), metadata);
        }
        String signature = Signatures.paymentSignature(payment.getOrderId(), payment.getId(), merchantService.keySecretOf(merchant));
        return CheckoutPaymentResponse.builder()
                .paymentId(payment.getId())
                .orderId(payment.getOrderId())
                .signature(signature)
                .status(EntityMapper.lower(payment.getStatus()))
                .build();
    }
}
