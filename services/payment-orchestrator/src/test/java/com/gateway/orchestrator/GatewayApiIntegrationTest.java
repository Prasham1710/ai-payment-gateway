package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gateway.orchestrator.FakeBankServer.Mode;
import com.gateway.orchestrator.service.RefundService;
import com.gateway.orchestrator.service.WebhookDispatcher;
import com.gateway.orchestrator.support.Signatures;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class GatewayApiIntegrationTest {

    private static final FakeBankServer BANK = startBank();

    @DynamicPropertySource
    static void bankUrl(DynamicPropertyRegistry registry) {
        registry.add("simulator.base-url", BANK::baseUrl);
    }

    @AfterAll
    static void stopBank() {
        BANK.close();
    }

    @Autowired
    private TestRestTemplate http;
    @Autowired
    private WebhookDispatcher webhookDispatcher;
    @Autowired
    private RefundService refundService;
    @Autowired
    private ObjectMapper objectMapper;

    private record Keys(String accountId, String keyId, String keySecret) {
    }

    @BeforeEach
    void resetBank() {
        BANK.reset();
    }

    @Test
    void signupIssuesApiKeysAndMerchantApisRequireThem() {
        Keys keys = signup();
        assertThat(keys.keyId()).startsWith("key_test_");
        assertThat(keys.keySecret()).hasSize(24);

        ResponseEntity<JsonNode> anonymous = http.getForEntity("/v1/orders", JsonNode.class);
        assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(anonymous.getBody().at("/error/code").asText()).isEqualTo("BAD_REQUEST_ERROR");
        assertThat(anonymous.getBody().at("/error/description").asText()).isEqualTo("Authentication failed");

        ResponseEntity<JsonNode> wrongSecret = http.withBasicAuth(keys.keyId(), "not-the-secret").getForEntity("/v1/orders", JsonNode.class);
        assertThat(wrongSecret.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        ResponseEntity<JsonNode> me = as(keys).getForEntity("/v1/merchants/me", JsonNode.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(me.getBody().get("id").asText()).isEqualTo(keys.accountId());
        assertThat(me.getBody().has("key_secret")).isFalse();

        ResponseEntity<JsonNode> unknownRoute = as(keys).getForEntity("/v1/unknown", JsonNode.class);
        assertThat(unknownRoute.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(unknownRoute.getBody().at("/error/code").asText()).isEqualTo("BAD_REQUEST_ERROR");

        ResponseEntity<JsonNode> duplicate = http.postForEntity("/v1/merchants",
                Map.of("name", "Again", "email", me.getBody().get("email").asText()), JsonNode.class);
        assertThat(duplicate.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(duplicate.getBody().at("/error/field").asText()).isEqualTo("email");
    }

    @Test
    void orderValidationUsesRazorpayErrorFormat() {
        Keys keys = signup();

        ResponseEntity<JsonNode> tooSmall = as(keys).postForEntity("/v1/orders", Map.of("amount", 50), JsonNode.class);
        assertThat(tooSmall.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(tooSmall.getBody().at("/error/code").asText()).isEqualTo("BAD_REQUEST_ERROR");
        assertThat(tooSmall.getBody().at("/error/field").asText()).isEqualTo("amount");
        assertThat(tooSmall.getBody().at("/error/reason").asText()).isEqualTo("input_validation_failed");

        ResponseEntity<JsonNode> fractional = as(keys).postForEntity("/v1/orders", Map.of("amount", 500.5), JsonNode.class);
        assertThat(fractional.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        ResponseEntity<JsonNode> usd = as(keys).postForEntity("/v1/orders", Map.of("amount", 5000, "currency", "USD"), JsonNode.class);
        assertThat(usd.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(usd.getBody().at("/error/field").asText()).isEqualTo("currency");

        ResponseEntity<JsonNode> tooManyNotes = as(keys).postForEntity("/v1/orders", Map.of("amount", 5000, "notes", manyNotes(16)), JsonNode.class);
        assertThat(tooManyNotes.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(tooManyNotes.getBody().at("/error/field").asText()).isEqualTo("notes");
    }

    @Test
    void checkoutAutoCapturesAndReturnsVerifiableSignature() {
        Keys keys = signup();
        JsonNode order = createOrder(keys, Map.of("amount", 50000, "receipt", "rcpt_1", "notes", Map.of("customer", "Ravi")));
        assertThat(order.get("id").asText()).startsWith("order_");
        assertThat(order.get("status").asText()).isEqualTo("created");
        assertThat(order.get("amount_due").asLong()).isEqualTo(50000);
        assertThat(order.at("/notes/customer").asText()).isEqualTo("Ravi");
        String orderId = order.get("id").asText();

        JsonNode summary = http.getForObject("/v1/checkout/orders/" + orderId + "?key_id=" + keys.keyId(), JsonNode.class);
        assertThat(summary.get("amount").asLong()).isEqualTo(50000);
        assertThat(summary.get("merchant_name").asText()).isEqualTo("Acme Store");

        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway",
                "email", "ravi@example.com", "contact", "+919876543210"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.OK);
        String paymentId = paid.getBody().get("payment_id").asText();
        assertThat(paymentId).startsWith("pay_");
        assertThat(paid.getBody().get("status").asText()).isEqualTo("captured");
        assertThat(paid.getBody().get("signature").asText())
                .isEqualTo(Signatures.hmacSha256Hex(orderId + "|" + paymentId, keys.keySecret()));

        JsonNode payment = as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class);
        assertThat(payment.get("entity").asText()).isEqualTo("payment");
        assertThat(payment.get("status").asText()).isEqualTo("captured");
        assertThat(payment.get("captured").asBoolean()).isTrue();
        assertThat(payment.get("method").asText()).isEqualTo("upi");
        assertThat(payment.get("vpa").asText()).isEqualTo("success@gateway");
        assertThat(payment.get("fee").asLong()).isEqualTo(1180);   // 2% of 50000 = 1000, plus 18% GST = 180
        assertThat(payment.get("tax").asLong()).isEqualTo(180);
        assertThat(payment.get("provider").asText()).isEqualTo("provider-a");
        assertThat(payment.get("attempts").asInt()).isEqualTo(1);
        assertThat(payment.at("/acquirer_data/bank_reference").asText()).startsWith("BANKREF_");

        JsonNode paidOrder = as(keys).getForObject("/v1/orders/" + orderId, JsonNode.class);
        assertThat(paidOrder.get("status").asText()).isEqualTo("paid");
        assertThat(paidOrder.get("amount_paid").asLong()).isEqualTo(50000);
        assertThat(paidOrder.get("amount_due").asLong()).isZero();
        assertThat(paidOrder.get("attempts").asInt()).isEqualTo(1);

        ResponseEntity<JsonNode> again = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway"));
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(again.getBody().at("/error/description").asText()).contains("already been paid");

        JsonNode orderPayments = as(keys).getForObject("/v1/orders/" + orderId + "/payments", JsonNode.class);
        assertThat(orderPayments.get("entity").asText()).isEqualTo("collection");
        assertThat(orderPayments.get("count").asInt()).isEqualTo(1);

        JsonNode allPayments = as(keys).getForObject("/v1/payments?count=5", JsonNode.class);
        assertThat(allPayments.at("/items/0/id").asText()).isEqualTo(paymentId);
    }

    @Test
    void failsOverOnlyWhenARailIsDown() {
        Keys keys = signup();

        BANK.setMode("provider-a", Mode.DOWN);
        String orderId = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.OK);
        String paymentId = paid.getBody().get("payment_id").asText();
        JsonNode attempts = as(keys).getForObject("/v1/payments/" + paymentId + "/attempts", JsonNode.class);
        assertThat(attempts.get("count").asInt()).isEqualTo(2);
        assertThat(attempts.at("/items/0/provider").asText()).isEqualTo("provider-a");
        assertThat(attempts.at("/items/0/status").asText()).isEqualTo("unavailable");
        assertThat(attempts.at("/items/1/provider").asText()).isEqualTo("provider-b");
        assertThat(attempts.at("/items/1/status").asText()).isEqualTo("success");
        assertThat(as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class).get("provider").asText()).isEqualTo("provider-b");

        // A bank decline is final: retrying on another rail would just charge the customer again.
        BANK.reset();
        BANK.setMode("provider-a", Mode.DECLINE);
        String declinedOrder = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> declined = pay(keys, declinedOrder, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(declined.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(declined.getBody().at("/error/reason").asText()).isEqualTo("insufficient_funds");
        assertThat(declined.getBody().at("/error/source").asText()).isEqualTo("bank");
        String declinedPayment = declined.getBody().at("/error/metadata/payment_id").asText();
        assertThat(declinedPayment).startsWith("pay_");
        assertThat(BANK.chargeCalls("provider-b")).isZero();
        JsonNode failed = as(keys).getForObject("/v1/payments/" + declinedPayment, JsonNode.class);
        assertThat(failed.get("status").asText()).isEqualTo("failed");
        assertThat(failed.get("error_reason").asText()).isEqualTo("insufficient_funds");
        assertThat(as(keys).getForObject("/v1/orders/" + declinedOrder, JsonNode.class).get("status").asText()).isEqualTo("attempted");

        // The customer can retry the same order with another instrument.
        BANK.setMode("provider-a", Mode.APPROVE);
        assertThat(pay(keys, declinedOrder, Map.of("method", "upi", "vpa", "ravi@okaxis")).getStatusCode()).isEqualTo(HttpStatus.OK);

        BANK.reset();
        List.of("provider-a", "provider-b", "provider-c").forEach(p -> BANK.setMode(p, Mode.DOWN));
        String downOrder = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> allDown = pay(keys, downOrder, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(allDown.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(allDown.getBody().at("/error/code").asText()).isEqualTo("GATEWAY_ERROR");
        assertThat(allDown.getBody().at("/error/reason").asText()).isEqualTo("all_providers_unavailable");
        assertThat(BANK.totalChargeCalls()).isEqualTo(3);
    }

    @Test
    void manualCaptureFlow() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 25000, "payment_capture", false)).get("id").asText();

        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway"));
        assertThat(paid.getBody().get("status").asText()).isEqualTo("authorized");
        String paymentId = paid.getBody().get("payment_id").asText();
        assertThat(as(keys).getForObject("/v1/orders/" + orderId, JsonNode.class).get("status").asText()).isEqualTo("attempted");

        ResponseEntity<JsonNode> refundBeforeCapture = as(keys).postForEntity("/v1/payments/" + paymentId + "/refund", Map.of(), JsonNode.class);
        assertThat(refundBeforeCapture.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        ResponseEntity<JsonNode> wrongAmount = as(keys).postForEntity("/v1/payments/" + paymentId + "/capture",
                Map.of("amount", 10000, "currency", "INR"), JsonNode.class);
        assertThat(wrongAmount.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(wrongAmount.getBody().at("/error/field").asText()).isEqualTo("amount");

        ResponseEntity<JsonNode> captured = as(keys).postForEntity("/v1/payments/" + paymentId + "/capture",
                Map.of("amount", 25000, "currency", "INR"), JsonNode.class);
        assertThat(captured.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(captured.getBody().get("status").asText()).isEqualTo("captured");
        assertThat(captured.getBody().get("fee").asLong()).isEqualTo(590);  // 500 + 90 GST
        assertThat(as(keys).getForObject("/v1/orders/" + orderId, JsonNode.class).get("status").asText()).isEqualTo("paid");

        ResponseEntity<JsonNode> twice = as(keys).postForEntity("/v1/payments/" + paymentId + "/capture",
                Map.of("amount", 25000, "currency", "INR"), JsonNode.class);
        assertThat(twice.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(twice.getBody().at("/error/description").asText()).contains("already been captured");
    }

    @Test
    void partialThenFullRefund() {
        Keys keys = signup();
        String paymentId = capturedPayment(keys, 50000);

        JsonNode first = as(keys).postForObject("/v1/payments/" + paymentId + "/refund",
                Map.of("amount", 20000, "notes", Map.of("reason", "damaged item")), JsonNode.class);
        assertThat(first.get("id").asText()).startsWith("rfnd_");
        assertThat(first.get("status").asText()).isEqualTo("processed");
        assertThat(first.at("/acquirer_data/arn").asText()).startsWith("ARN_");
        JsonNode partiallyRefunded = as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class);
        assertThat(partiallyRefunded.get("status").asText()).isEqualTo("captured");
        assertThat(partiallyRefunded.get("refund_status").asText()).isEqualTo("partial");
        assertThat(partiallyRefunded.get("amount_refunded").asLong()).isEqualTo(20000);

        ResponseEntity<JsonNode> tooMuch = as(keys).postForEntity("/v1/payments/" + paymentId + "/refund",
                Map.of("amount", 40000), JsonNode.class);
        assertThat(tooMuch.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(tooMuch.getBody().at("/error/field").asText()).isEqualTo("amount");

        JsonNode rest = as(keys).postForObject("/v1/payments/" + paymentId + "/refund", Map.of(), JsonNode.class);
        assertThat(rest.get("amount").asLong()).isEqualTo(30000);
        JsonNode refunded = as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class);
        assertThat(refunded.get("status").asText()).isEqualTo("refunded");
        assertThat(refunded.get("refund_status").asText()).isEqualTo("full");

        ResponseEntity<JsonNode> afterFull = as(keys).postForEntity("/v1/payments/" + paymentId + "/refund", Map.of(), JsonNode.class);
        assertThat(afterFull.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(as(keys).getForObject("/v1/payments/" + paymentId + "/refunds", JsonNode.class).get("count").asInt()).isEqualTo(2);
        assertThat(as(keys).getForObject("/v1/refunds/" + first.get("id").asText(), JsonNode.class).get("payment_id").asText())
                .isEqualTo(paymentId);
    }

    @Test
    void refundStaysPendingWhileTheRailIsDownAndIsRetried() {
        Keys keys = signup();
        String paymentId = capturedPayment(keys, 30000);

        BANK.setRefundsDown(true);
        JsonNode refund = as(keys).postForObject("/v1/payments/" + paymentId + "/refund", Map.of("amount", 10000), JsonNode.class);
        assertThat(refund.get("status").asText()).isEqualTo("pending");
        // The amount is reserved while pending, so it cannot be refunded twice.
        assertThat(as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class).get("amount_refunded").asLong()).isEqualTo(10000);

        BANK.setRefundsDown(false);
        refundService.attempt(refund.get("id").asText());
        assertThat(as(keys).getForObject("/v1/refunds/" + refund.get("id").asText(), JsonNode.class).get("status").asText())
                .isEqualTo("processed");
    }

    @Test
    void webhooksAreSignedAndRetriedUntilDelivered() throws IOException {
        Keys keys = signup();
        String secret = "whsec_test_123";
        JsonNode webhook = as(keys).postForObject("/v1/webhooks", Map.of("url", BANK.baseUrl() + "/hooks",
                "secret", secret, "events", List.of("payment.captured", "order.paid")), JsonNode.class);
        assertThat(webhook.get("id").asText()).startsWith("wh_");
        assertThat(webhook.has("secret")).isFalse();

        String paymentId = capturedPayment(keys, 10000);
        webhookDispatcher.dispatchDue();

        assertThat(BANK.webhooks()).hasSize(2);
        for (FakeBankServer.ReceivedWebhook received : BANK.webhooks()) {
            assertThat(received.signature()).isEqualTo(Signatures.hmacSha256Hex(received.body(), secret));
            JsonNode event = objectMapper.readTree(received.body());
            assertThat(event.get("entity").asText()).isEqualTo("event");
            assertThat(event.get("account_id").asText()).isEqualTo(keys.accountId());
            assertThat(event.get("event").asText()).isEqualTo(received.event());
            assertThat(event.at("/payload/payment/entity/id").asText()).isEqualTo(paymentId);
            assertThat(event.at("/payload/payment/entity/status").asText()).isEqualTo("captured");
        }
        assertThat(BANK.webhooks()).extracting(FakeBankServer.ReceivedWebhook::event)
                .containsExactlyInAnyOrder("payment.captured", "order.paid");

        String webhookId = webhook.get("id").asText();
        JsonNode delivered = as(keys).getForObject("/v1/webhooks/" + webhookId + "/deliveries", JsonNode.class);
        assertThat(delivered.get("count").asInt()).isEqualTo(2);
        assertThat(delivered.at("/items/0/status").asText()).isEqualTo("delivered");

        // Receiver is down: the delivery stays pending and is retried.
        BANK.reset();
        BANK.setWebhookStatus(500);
        capturedPayment(keys, 10000);
        webhookDispatcher.dispatchDue();
        JsonNode failing = as(keys).getForObject("/v1/webhooks/" + webhookId + "/deliveries?count=2", JsonNode.class);
        assertThat(failing.at("/items/0/status").asText()).isEqualTo("pending");
        assertThat(failing.at("/items/0/attempts").asInt()).isEqualTo(1);
        assertThat(failing.at("/items/0/last_response_code").asInt()).isEqualTo(500);

        BANK.setWebhookStatus(200);
        webhookDispatcher.dispatchDue();
        JsonNode recovered = as(keys).getForObject("/v1/webhooks/" + webhookId + "/deliveries?count=2", JsonNode.class);
        assertThat(recovered.at("/items/0/status").asText()).isEqualTo("delivered");
        assertThat(recovered.at("/items/0/attempts").asInt()).isEqualTo(2);
        // Every attempt of the same event carries the same event id, so receivers can de-duplicate.
        assertThat(BANK.webhooks().stream().map(FakeBankServer.ReceivedWebhook::eventId).distinct()).hasSize(2);
    }

    @Test
    void merchantsCannotSeeEachOthersData() {
        Keys alice = signup();
        Keys bob = signup();
        String aliceOrder = createOrder(alice, Map.of("amount", 10000)).get("id").asText();

        assertThat(as(bob).getForEntity("/v1/orders/" + aliceOrder, JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        Map<String, Object> body = new HashMap<>(Map.of("key_id", bob.keyId(), "order_id", aliceOrder, "method", "upi", "vpa", "bob@okaxis"));
        assertThat(http.postForEntity("/v1/checkout/payments", body, JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(BANK.totalChargeCalls()).isZero();
    }

    @Test
    void idempotencyKeyReplaysTheSamePayment() {
        Keys keys = signup();
        String orderId = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        Map<String, Object> body = Map.of("key_id", keys.keyId(), "order_id", orderId, "method", "upi", "vpa", "success@gateway");
        HttpHeaders headers = new HttpHeaders();
        headers.set("Idempotency-Key", "checkout-" + UUID.randomUUID());

        JsonNode first = http.postForObject("/v1/checkout/payments", new HttpEntity<>(body, headers), JsonNode.class);
        JsonNode second = http.postForObject("/v1/checkout/payments", new HttpEntity<>(body, headers), JsonNode.class);
        assertThat(second.get("payment_id").asText()).isEqualTo(first.get("payment_id").asText());
        assertThat(second.get("signature").asText()).isEqualTo(first.get("signature").asText());
        assertThat(BANK.totalChargeCalls()).isEqualTo(1);
    }

    @Test
    void cardAndNetbankingPayments() {
        Keys keys = signup();

        String orderId = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> badCard = pay(keys, orderId, Map.of("method", "card", "card", card("4111111111111112")));
        assertThat(badCard.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(badCard.getBody().at("/error/field").asText()).isEqualTo("card.number");

        ResponseEntity<JsonNode> cardPaid = pay(keys, orderId, Map.of("method", "card", "card", card("4111 1111 1111 1111")));
        assertThat(cardPaid.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode cardPayment = as(keys).getForObject("/v1/payments/" + cardPaid.getBody().get("payment_id").asText(), JsonNode.class);
        assertThat(cardPayment.at("/card/last4").asText()).isEqualTo("1111");
        assertThat(cardPayment.at("/card/network").asText()).isEqualTo("Visa");
        assertThat(cardPayment.toString()).doesNotContain("4111111111111111").doesNotContain("\"cvv\"");

        String declinedOrder = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> declinedCard = pay(keys, declinedOrder, Map.of("method", "card", "card", card("4000000000000002")));
        assertThat(declinedCard.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        String nbOrder = createOrder(keys, Map.of("amount", 10000)).get("id").asText();
        ResponseEntity<JsonNode> badBank = pay(keys, nbOrder, Map.of("method", "netbanking", "bank", "XXXX"));
        assertThat(badBank.getBody().at("/error/field").asText()).isEqualTo("bank");
        ResponseEntity<JsonNode> nbPaid = pay(keys, nbOrder, Map.of("method", "netbanking", "bank", "HDFC"));
        assertThat(nbPaid.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // --- helpers -------------------------------------------------------------------------------

    private Keys signup() {
        ResponseEntity<JsonNode> response = http.postForEntity("/v1/merchants",
                Map.of("name", "Acme Store", "email", "owner-" + UUID.randomUUID() + "@example.com"), JsonNode.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = response.getBody();
        return new Keys(body.get("id").asText(), body.get("key_id").asText(), body.get("key_secret").asText());
    }

    private TestRestTemplate as(Keys keys) {
        return http.withBasicAuth(keys.keyId(), keys.keySecret());
    }

    private JsonNode createOrder(Keys keys, Map<String, Object> body) {
        ResponseEntity<JsonNode> response = as(keys).postForEntity("/v1/orders", body, JsonNode.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    private ResponseEntity<JsonNode> pay(Keys keys, String orderId, Map<String, Object> instrument) {
        Map<String, Object> body = new HashMap<>(instrument);
        body.put("key_id", keys.keyId());
        body.put("order_id", orderId);
        return http.postForEntity("/v1/checkout/payments", body, JsonNode.class);
    }

    private String capturedPayment(Keys keys, long amount) {
        String orderId = createOrder(keys, Map.of("amount", amount)).get("id").asText();
        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.OK);
        return paid.getBody().get("payment_id").asText();
    }

    private static Map<String, Object> card(String number) {
        return Map.of("number", number, "name", "Ravi Kumar", "expiry_month", 12, "expiry_year", 2035, "cvv", "123");
    }

    private static Map<String, String> manyNotes(int count) {
        Map<String, String> notes = new HashMap<>();
        for (int i = 0; i < count; i++) {
            notes.put("key" + i, "value");
        }
        return notes;
    }

    private static FakeBankServer startBank() {
        try {
            return new FakeBankServer();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
