package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.gateway.orchestrator.service.WebhookDispatcher;

import java.io.IOException;
import java.time.Duration;
import java.io.UncheckedIOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

/** Shared Spring context (H2 + fake bank) and API helpers for the integration tests. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
abstract class IntegrationTestSupport {

    protected static final FakeBankServer BANK = startBank();

    @DynamicPropertySource
    static void bankUrl(DynamicPropertyRegistry registry) {
        registry.add("simulator.base-url", BANK::baseUrl);
    }

    @AfterAll
    static void resetBankAfterClass() {
        BANK.reset();
    }

    @Autowired
    protected TestRestTemplate http;

    protected record Keys(String accountId, String keyId, String keySecret) {
    }

    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private WebhookDispatcher dispatcher;

    @BeforeEach
    void resetBank() throws InterruptedException {
        BANK.reset();
        // Every test starts with an idle dispatcher and an empty webhook outbox, so sends left over
        // from earlier tests cannot claim this test's deliveries.
        assertThat(dispatcher.awaitIdle(Duration.ofSeconds(10))).isTrue();
        jdbcTemplate.update("update webhook_deliveries set status = 'FAILED' where status = 'PENDING'");
    }

    protected Keys signup() {
        ResponseEntity<JsonNode> response = http.postForEntity("/v1/merchants",
                Map.of("name", "Acme Store", "email", "owner-" + UUID.randomUUID() + "@example.com"), JsonNode.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = response.getBody();
        return new Keys(body.get("id").asText(), body.get("key_id").asText(), body.get("key_secret").asText());
    }

    protected TestRestTemplate as(Keys keys) {
        return http.withBasicAuth(keys.keyId(), keys.keySecret());
    }

    protected JsonNode createOrder(Keys keys, Map<String, Object> body) {
        ResponseEntity<JsonNode> response = as(keys).postForEntity("/v1/orders", body, JsonNode.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    protected ResponseEntity<JsonNode> pay(Keys keys, String orderId, Map<String, Object> instrument) {
        Map<String, Object> body = new HashMap<>(instrument);
        body.put("key_id", keys.keyId());
        body.put("order_id", orderId);
        return http.postForEntity("/v1/checkout/payments", body, JsonNode.class);
    }

    protected String capturedPayment(Keys keys, long amount) {
        String orderId = createOrder(keys, Map.of("amount", amount)).get("id").asText();
        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "success@gateway"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.OK);
        return paid.getBody().get("payment_id").asText();
    }

    protected JsonNode payment(Keys keys, String paymentId) {
        return as(keys).getForObject("/v1/payments/" + paymentId, JsonNode.class);
    }

    /** Waits for webhook sends started by {@code WebhookDispatcher.dispatchDue()}. */
    protected static void awaitAll(List<Future<?>> sends) {
        for (Future<?> send : sends) {
            try {
                send.get();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            } catch (ExecutionException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    protected static Map<String, Object> card(String number) {
        return Map.of("number", number, "name", "Ravi Kumar", "expiry_month", 12, "expiry_year", 2035, "cvv", "123");
    }

    protected static Map<String, String> manyNotes(int count) {
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
