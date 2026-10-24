package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.gateway.orchestrator.FakeBankServer.Mode;
import com.gateway.orchestrator.FakeBankServer.RefundMode;
import com.gateway.orchestrator.domain.AttemptStatus;
import com.gateway.orchestrator.domain.Payment;
import com.gateway.orchestrator.domain.PaymentMethod;
import com.gateway.orchestrator.domain.PaymentStatus;
import com.gateway.orchestrator.domain.Transaction;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.repository.TransactionRepository;
import com.gateway.orchestrator.service.PaymentReconciler;
import com.gateway.orchestrator.service.RefundService;
import com.gateway.orchestrator.support.Ids;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Money-safety behaviour: unknown bank outcomes, late authorizations, automatic refunds, unconfirmed refunds, limits. */
class ReliabilityIntegrationTest extends IntegrationTestSupport {

    @Autowired
    private PaymentReconciler reconciler;
    @Autowired
    private RefundService refundService;
    @Autowired
    private PaymentRepository paymentRepository;
    @Autowired
    private TransactionRepository transactionRepository;
    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void ambiguousBankErrorIsNotFailedOverAndIsReconciledIntoALateCapture() {
        Keys keys = signup();
        BANK.setMode("provider-a", Mode.GATEWAY_ERROR);   // the bank charges the customer but answers 502
        String orderId = createOrder(keys, Map.of("amount", 20000)).get("id").asText();

        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(paid.getBody().at("/error/reason").asText()).isEqualTo("bank_outcome_unknown");
        assertThat(BANK.chargeCalls("provider-b")).as("must not charge a second rail").isZero();
        String paymentId = paid.getBody().at("/error/metadata/payment_id").asText();
        JsonNode attempts = as(keys).getForObject("/v1/payments/" + paymentId + "/attempts", JsonNode.class);
        assertThat(attempts.at("/items/0/status").asText()).isEqualTo("unknown");

        // The bank has not confirmed yet: still failed, still being reconciled.
        reconciler.reconcile(paymentId);
        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("failed");

        BANK.settlePendingCharges();
        reconciler.reconcile(paymentId);
        JsonNode late = payment(keys, paymentId);
        assertThat(late.get("status").asText()).isEqualTo("captured");
        assertThat(late.get("error_reason").isNull()).isTrue();
        assertThat(late.get("provider").asText()).isEqualTo("provider-a");
        assertThat(as(keys).getForObject("/v1/orders/" + orderId, JsonNode.class).get("status").asText()).isEqualTo("paid");
        assertThat(paymentRepository.findById(paymentId).orElseThrow().getReconcileUntil()).isNull();
    }

    @Test
    void readTimeoutIsTreatedAsUnknownNotAsAFailover() {
        Keys keys = signup();
        BANK.setMode("provider-a", Mode.SLOW);
        String orderId = createOrder(keys, Map.of("amount", 15000)).get("id").asText();

        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(paid.getBody().at("/error/reason").asText()).isEqualTo("bank_outcome_unknown");
        assertThat(BANK.chargeCalls("provider-b")).isZero();
        String paymentId = paid.getBody().at("/error/metadata/payment_id").asText();

        String txId = transactionRepository.findByPaymentIdOrderByCreatedAtAsc(paymentId).get(0).getId();
        await().atMost(Duration.ofSeconds(5)).until(() -> BANK.hasCharge(txId));
        reconciler.reconcile(paymentId);
        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("captured");
    }

    @Test
    void lateAuthorizationOnAnAlreadyPaidOrderIsRefundedAutomatically() {
        Keys keys = signup();
        BANK.setMode("provider-a", Mode.GATEWAY_ERROR);
        String orderId = createOrder(keys, Map.of("amount", 30000)).get("id").asText();
        String first = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"))
                .getBody().at("/error/metadata/payment_id").asText();

        // The customer saw a failure and paid again successfully.
        BANK.setMode("provider-a", Mode.APPROVE);
        assertThat(pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis")).getStatusCode()).isEqualTo(HttpStatus.OK);

        // Then the bank confirms the first charge after all.
        BANK.settlePendingCharges();
        reconciler.reconcile(first);
        assertThat(payment(keys, first).get("status").asText()).isEqualTo("authorized");

        refundService.refundUncapturableAuthorizations();
        JsonNode refunded = payment(keys, first);
        assertThat(refunded.get("status").asText()).isEqualTo("refunded");
        assertThat(refunded.get("captured").asBoolean()).isFalse();
        assertThat(refunded.get("fee").isNull()).isTrue();
        JsonNode refunds = as(keys).getForObject("/v1/payments/" + first + "/refunds", JsonNode.class);
        assertThat(refunds.at("/items/0/status").asText()).isEqualTo("processed");
        assertThat(refunds.at("/items/0/notes/reason").asText()).isEqualTo("order_paid_by_another_payment");
    }

    @Test
    void secondAuthorizationOnAManualCaptureOrderIsRefundedOnceTheOrderIsPaid() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 25000, "payment_capture", false)).get("id").asText();
        String first = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();
        String second = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();

        assertThat(as(keys).postForEntity("/v1/payments/" + second + "/capture",
                Map.of("amount", 25000, "currency", "INR"), JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<JsonNode> captureFirst = as(keys).postForEntity("/v1/payments/" + first + "/capture",
                Map.of("amount", 25000, "currency", "INR"), JsonNode.class);
        assertThat(captureFirst.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(captureFirst.getBody().at("/error/description").asText()).contains("refunded automatically");

        refundService.refundUncapturableAuthorizations();
        assertThat(payment(keys, first).get("status").asText()).isEqualTo("refunded");
        assertThat(payment(keys, second).get("status").asText()).isEqualTo("captured");
        // A second sweep does nothing more.
        refundService.refundUncapturableAuthorizations();
        assertThat(as(keys).getForObject("/v1/payments/" + first + "/refunds", JsonNode.class).get("count").asInt()).isEqualTo(1);
    }

    @Test
    void authorizationsOlderThanTheCaptureWindowAreRefunded() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 12000, "payment_capture", false)).get("id").asText();
        String paymentId = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();

        refundService.refundUncapturableAuthorizations();
        assertThat(payment(keys, paymentId).get("status").asText()).as("still inside the capture window").isEqualTo("authorized");

        backdate(paymentId, Duration.ofDays(6));
        refundService.refundUncapturableAuthorizations();
        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("refunded");
        assertThat(as(keys).getForObject("/v1/payments/" + paymentId + "/refunds", JsonNode.class)
                .at("/items/0/notes/reason").asText()).isEqualTo("not_captured_within_capture_window");
    }

    @Test
    void merchantCanReverseAnUncapturedAuthorizationInFullOnly() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 40000, "payment_capture", false)).get("id").asText();
        String paymentId = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();

        ResponseEntity<JsonNode> partial = as(keys).postForEntity("/v1/payments/" + paymentId + "/refund", Map.of("amount", 1000), JsonNode.class);
        assertThat(partial.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(partial.getBody().at("/error/field").asText()).isEqualTo("amount");

        JsonNode reversal = as(keys).postForObject("/v1/payments/" + paymentId + "/refund", Map.of(), JsonNode.class);
        assertThat(reversal.get("amount").asLong()).isEqualTo(40000);
        assertThat(reversal.get("status").asText()).isEqualTo("processed");
        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("refunded");
        assertThat(as(keys).postForEntity("/v1/payments/" + paymentId + "/capture",
                Map.of("amount", 40000, "currency", "INR"), JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void abandonedCheckoutsAreSettledFromTheirRecordedAttempts() {
        Keys keys = signup();
        // Checkout process died after the bank approved the charge but before the result was saved.
        String approvedOrder = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        String approved = abandonedPayment(keys, approvedOrder, AttemptStatus.SUCCESS);
        // Checkout process died before any bank call.
        String untouchedOrder = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        String untouched = abandonedPayment(keys, untouchedOrder, null);

        reconciler.reconcileDue();

        assertThat(payment(keys, approved).get("status").asText()).isEqualTo("captured");
        assertThat(as(keys).getForObject("/v1/orders/" + approvedOrder, JsonNode.class).get("status").asText()).isEqualTo("paid");
        JsonNode failed = payment(keys, untouched);
        assertThat(failed.get("status").asText()).isEqualTo("failed");
        assertThat(failed.get("error_reason").asText()).isEqualTo("server_error");
        // The order can be paid again.
        assertThat(pay(keys, untouchedOrder, Map.of("method", "upi", "vpa", "success@gateway")).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void refundWithAnUnconfirmedOutcomeIsNeverReleased() {
        Keys keys = signup();
        String paymentId = capturedPayment(keys, 30000);

        BANK.setRefundMode(RefundMode.GATEWAY_ERROR);
        String refundId = as(keys).postForObject("/v1/payments/" + paymentId + "/refund", Map.of("amount", 10000), JsonNode.class)
                .get("id").asText();
        refundService.attempt(refundId);   // max-attempts (2) reached, but the bank may have paid it out

        JsonNode refund = as(keys).getForObject("/v1/refunds/" + refundId, JsonNode.class);
        assertThat(refund.get("status").asText()).isEqualTo("pending");
        assertThat(payment(keys, paymentId).get("amount_refunded").asLong()).isEqualTo(10000);

        BANK.setRefundMode(RefundMode.PROCESS);
        refundService.attempt(refundId);
        assertThat(as(keys).getForObject("/v1/refunds/" + refundId, JsonNode.class).get("status").asText()).isEqualTo("processed");
    }

    @Test
    void refundIsFailedAndReleasedWhenTheRailStaysDown() {
        Keys keys = signup();
        String paymentId = capturedPayment(keys, 30000);

        BANK.setRefundMode(RefundMode.DOWN);
        String refundId = as(keys).postForObject("/v1/payments/" + paymentId + "/refund", Map.of("amount", 10000), JsonNode.class)
                .get("id").asText();
        refundService.attempt(refundId);

        assertThat(as(keys).getForObject("/v1/refunds/" + refundId, JsonNode.class).get("status").asText()).isEqualTo("failed");
        JsonNode released = payment(keys, paymentId);
        assertThat(released.get("amount_refunded").asLong()).isZero();
        assertThat(released.get("status").asText()).isEqualTo("captured");
        assertThat(released.get("refund_status").isNull()).isTrue();
    }

    @Test
    void oversizedInputsAreRejectedWith400() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 10000)).get("id").asText();

        ResponseEntity<JsonNode> longVpa = pay(keys, orderId, Map.of("method", "upi", "vpa", "a".repeat(90) + "@okaxis"));
        assertThat(longVpa.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(longVpa.getBody().at("/error/field").asText()).isEqualTo("vpa");

        String paymentId = capturedPayment(keys, 10000);
        HttpHeaders headers = new HttpHeaders();
        headers.set("Idempotency-Key", "k".repeat(65));
        ResponseEntity<JsonNode> longKey = as(keys).postForEntity("/v1/payments/" + paymentId + "/refund",
                new HttpEntity<>(Map.of(), headers), JsonNode.class);
        assertThat(longKey.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(longKey.getBody().at("/error/field").asText()).isEqualTo("idempotency_key");

        ResponseEntity<JsonNode> farFuture = as(keys).getForEntity("/v1/orders?from=99999999999999", JsonNode.class);
        assertThat(farFuture.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(farFuture.getBody().at("/error/field").asText()).isEqualTo("from");

        ResponseEntity<JsonNode> longSecret = as(keys).postForEntity("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks",
                "secret", "s".repeat(200), "events", List.of("*")), JsonNode.class);
        assertThat(longSecret.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(longSecret.getBody().at("/error/field").asText()).isEqualTo("secret");

        // Each control character is stored as a 6-character JSON escape, so these notes overflow the column.
        Map<String, String> escapeHeavyNotes = new HashMap<>();
        for (int i = 0; i < 15; i++) {
            escapeHeavyNotes.put("key" + i, "\u0001".repeat(256));
        }
        ResponseEntity<JsonNode> bigNotes = as(keys).postForEntity("/v1/orders", Map.of("amount", 10000, "notes", escapeHeavyNotes), JsonNode.class);
        assertThat(bigNotes.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bigNotes.getBody().at("/error/field").asText()).isEqualTo("notes");
    }

    @Test
    void pathParametersCannotSkipAuthentication() {
        ResponseEntity<JsonNode> response = http.getForEntity("/v1;public/orders", JsonNode.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void webhookEndpointsPerMerchantAreLimited() {
        Keys keys = signup();
        for (int i = 0; i < 10; i++) {
            assertThat(as(keys).postForEntity("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks/" + i,
                    "secret", "whsec_test_123", "events", List.of("*")), JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        }
        ResponseEntity<JsonNode> eleventh = as(keys).postForEntity("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks/x",
                "secret", "whsec_test_123", "events", List.of("*")), JsonNode.class);
        assertThat(eleventh.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /** Persists a payment as a crashed checkout would have left it: {@code created}, older than the in-flight window. */
    private String abandonedPayment(Keys keys, String orderId, AttemptStatus attemptStatus) {
        JsonNode order = as(keys).getForObject("/v1/orders/" + orderId, JsonNode.class);
        Payment payment = paymentRepository.save(Payment.builder()
                .id(Ids.newId("pay"))
                .merchantId(keys.accountId())
                .orderId(orderId)
                .amount(order.get("amount").asLong())
                .currency("INR")
                .status(PaymentStatus.CREATED)
                .method(PaymentMethod.UPI)
                .vpa("ravi@okaxis")
                .build());
        if (attemptStatus != null) {
            transactionRepository.save(Transaction.builder()
                    .id(Ids.newId("tx"))
                    .paymentId(payment.getId())
                    .providerId("provider-a")
                    .amount(payment.getAmount())
                    .status(attemptStatus)
                    .bankReference("BANKREF_crash")
                    .responseCode("00")
                    .latencyMs(100)
                    .build());
        }
        backdate(payment.getId(), Duration.ofMinutes(5));
        return payment.getId();
    }

    private void backdate(String paymentId, Duration age) {
        jdbc.update("update payments set created_at = ? where id = ?", Timestamp.from(Instant.now().minus(age)), paymentId);
    }
}
