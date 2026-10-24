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
import com.gateway.orchestrator.service.WebhookDispatcher;
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
import java.util.concurrent.Future;

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
    @Autowired
    private WebhookDispatcher webhookDispatcher;

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

    @Test
    void chargeInFlightDuringACrashIsFoundThroughItsWriteAheadAttempt() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        // The attempt row was written before the charge was sent; the process died before the answer.
        String paymentId = abandonedPayment(keys, orderId, AttemptStatus.UNKNOWN);
        BANK.recordCharge(attemptOf(paymentId).getId(), true);

        reconciler.reconcileDue();

        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("captured");
        assertThat(attemptOf(paymentId).getStatus()).isEqualTo(AttemptStatus.SUCCESS);
    }

    @Test
    void attemptTheBankNeverReceivedIsSettledAsNotProcessed() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        // Crashed after writing the attempt but before sending it: the bank has no record of it.
        String paymentId = abandonedPayment(keys, orderId, AttemptStatus.UNKNOWN);
        jdbc.update("update transactions set created_at = ? where payment_id = ?",
                Timestamp.from(Instant.now().minus(Duration.ofMinutes(5))), paymentId);

        reconciler.reconcile(paymentId);
        assertThat(payment(keys, paymentId).get("status").asText()).isEqualTo("failed");
        assertThat(attemptOf(paymentId).getStatus()).isEqualTo(AttemptStatus.UNAVAILABLE);

        reconciler.reconcile(paymentId);
        assertThat(paymentRepository.findById(paymentId).orElseThrow().getReconcileUntil())
                .as("nothing left to ask the bank about").isNull();
    }

    @Test
    void abandonedCheckoutDeclinedByTheBankKeepsTheDeclineReason() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        String paymentId = abandonedPayment(keys, orderId, AttemptStatus.UNKNOWN);
        BANK.recordCharge(attemptOf(paymentId).getId(), false);

        reconciler.reconcile(paymentId);

        JsonNode failed = payment(keys, paymentId);
        assertThat(failed.get("status").asText()).isEqualTo("failed");
        assertThat(failed.get("error_reason").asText()).isEqualTo("insufficient_funds");
        assertThat(failed.get("error_source").asText()).isEqualTo("bank");
    }

    @Test
    void inconclusiveChecksArePushedBackSoTheBatchRotates() {
        Keys keys = signup();
        BANK.setMode("provider-a", Mode.GATEWAY_ERROR);
        String orderId = createOrder(keys, Map.of("amount", 9900)).get("id").asText();
        String paymentId = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"))
                .getBody().at("/error/metadata/payment_id").asText();
        Instant firstCheck = paymentRepository.findById(paymentId).orElseThrow().getReconcileAfter();
        assertThat(firstCheck).isAfter(Instant.now());

        jdbc.update("update payments set reconcile_after = ? where id = ?", Timestamp.from(Instant.now().minusSeconds(1)), paymentId);
        reconciler.reconcileDue();

        Payment after = paymentRepository.findById(paymentId).orElseThrow();
        assertThat(after.getStatus()).isEqualTo(PaymentStatus.FAILED);
        assertThat(after.getReconcileUntil()).isNotNull();
        assertThat(after.getReconcileAfter()).as("next check scheduled in the future").isAfter(Instant.now());
    }

    @Test
    void failedAutomaticRefundIsRetriedAfterTheBackOff() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 25000, "payment_capture", false)).get("id").asText();
        String first = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();
        String second = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway")).getBody().get("payment_id").asText();
        as(keys).postForEntity("/v1/payments/" + second + "/capture", Map.of("amount", 25000, "currency", "INR"), JsonNode.class);

        BANK.setRefundMode(RefundMode.DOWN);
        refundService.refundUncapturableAuthorizations();             // attempt 1: rail down
        String refundId = as(keys).getForObject("/v1/payments/" + first + "/refunds", JsonNode.class).at("/items/0/id").asText();
        refundService.attempt(refundId);                              // attempt 2 (max): failed, amount released
        assertThat(payment(keys, first).get("status").asText()).isEqualTo("authorized");

        refundService.refundUncapturableAuthorizations();
        assertThat(as(keys).getForObject("/v1/payments/" + first + "/refunds", JsonNode.class).get("count").asInt())
                .as("not retried before the back-off").isEqualTo(1);

        BANK.setRefundMode(RefundMode.PROCESS);
        jdbc.update("update refunds set created_at = ? where id = ?", Timestamp.from(Instant.now().minus(Duration.ofHours(2))), refundId);
        refundService.refundUncapturableAuthorizations();
        assertThat(payment(keys, first).get("status").asText()).isEqualTo("refunded");
    }

    @Test
    void slowWebhookReceiverDoesNotHoldUpOtherMerchants() {
        Keys slowMerchant = signup();
        Keys normalMerchant = signup();
        String slowHook = as(slowMerchant).postForObject("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks/slow",
                "secret", "whsec_test_123", "events", List.of("payment.captured")), JsonNode.class).get("id").asText();
        String normalHook = as(normalMerchant).postForObject("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks",
                "secret", "whsec_test_123", "events", List.of("payment.captured")), JsonNode.class).get("id").asText();
        for (int i = 0; i < 3; i++) {
            capturedPayment(slowMerchant, 10000);
        }
        capturedPayment(normalMerchant, 10000);

        long start = System.nanoTime();
        List<Future<?>> sends = webhookDispatcher.dispatchDue();
        assertThat(Duration.ofNanos(System.nanoTime() - start)).as("the poll does not wait for receivers").isLessThan(Duration.ofMillis(500));
        assertThat(sends).as("at most 2 in flight per endpoint, plus the normal one").hasSize(3);

        await().atMost(Duration.ofMillis(800)).until(() -> "delivered".equals(
                as(normalMerchant).getForObject("/v1/webhooks/" + normalHook + "/deliveries", JsonNode.class).at("/items/0/status").asText()));
        awaitAll(sends);
        JsonNode slow = as(slowMerchant).getForObject("/v1/webhooks/" + slowHook + "/deliveries", JsonNode.class);
        List<String> errors = new java.util.ArrayList<>();
        slow.get("items").forEach(item -> errors.add(item.get("attempts").asInt() + ":" + item.get("last_error").asText()));
        // Two were sent and timed out; the third waited for the endpoint to have capacity.
        assertThat(errors).containsExactlyInAnyOrder("1:Receiver did not respond within 1000 ms",
                "1:Receiver did not respond within 1000 ms", "0:null");
    }

    @Test
    void absurdCardExpiryYearIsA400NotA500() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        Map<String, Object> card = new HashMap<>(card("4111111111111111"));
        card.put("expiry_year", -1999999999);
        ResponseEntity<JsonNode> response = pay(keys, orderId, Map.of("method", "card", "card", card));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().at("/error/field").asText()).isEqualTo("card.expiry_year");
    }

    private Transaction attemptOf(String paymentId) {
        return transactionRepository.findByPaymentIdOrderByCreatedAtAsc(paymentId).get(0);
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
