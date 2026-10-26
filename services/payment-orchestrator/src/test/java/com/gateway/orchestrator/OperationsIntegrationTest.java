package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.gateway.orchestrator.FakeBankServer.Mode;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Endpoints and behaviour the operations dashboard relies on: circuit breakers, analytics and CORS. */
class OperationsIntegrationTest extends IntegrationTestSupport {

    @Test
    void aRailThatKeepsFailingIsSkippedWithoutBeingChargedUntilItsBreakerIsReset() {
        Keys keys = signup();
        BANK.setAiRouter(null, 0);   // router down: configured order provider-a -> provider-b -> provider-c
        BANK.setMode("provider-a", Mode.DOWN);

        // provider-a's breaker needs 5 calls in its window before it can open (50% failure threshold).
        for (int i = 0; i < 5; i++) {
            String paymentId = capturedPayment(keys, 10000 + i);
            assertThat(attempts(keys, paymentId)).extracting(a -> a.get("provider").asText()).containsExactly("provider-a", "provider-b");
        }
        assertThat(breaker("provider-a").get("state").asText()).isEqualTo("OPEN");
        int chargesBefore = BANK.chargeCalls("provider-a");

        String skipped = capturedPayment(keys, 20000);
        List<JsonNode> skippedAttempts = attempts(keys, skipped);
        assertThat(skippedAttempts).extracting(a -> a.get("provider").asText()).containsExactly("provider-a", "provider-b");
        assertThat(skippedAttempts.get(0).get("status").asText()).isEqualTo("unavailable");
        assertThat(skippedAttempts.get(0).get("response_code").asText()).isEqualTo("CB_OPEN");
        assertThat(BANK.chargeCalls("provider-a")).isEqualTo(chargesBefore);   // nothing was sent to the open rail
        assertThat(breaker("provider-a").get("not_permitted_calls").asLong()).isEqualTo(1);

        BANK.setMode("provider-a", Mode.APPROVE);
        ResponseEntity<JsonNode> reset = http.postForEntity("/ops/circuit-breakers/provider-a/reset", null, JsonNode.class);
        assertThat(reset.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(reset.getBody().get("state").asText()).isEqualTo("CLOSED");
        assertThat(attempts(keys, capturedPayment(keys, 30000))).extracting(a -> a.get("provider").asText()).containsExactly("provider-a");

        assertThat(http.postForEntity("/ops/circuit-breakers/provider-x/reset", null, JsonNode.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void bankDeclinesDoNotOpenTheBreaker() {
        Keys keys = signup();
        BANK.setAiRouter(null, 0);
        BANK.setMode("provider-a", Mode.DECLINE);
        for (int i = 0; i < 6; i++) {
            String orderId = createOrder(keys, Map.of("amount", 5000)).get("id").asText();
            assertThat(pay(keys, orderId, Map.of("method", "upi", "vpa", "someone@okbank")).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        }
        JsonNode breaker = breaker("provider-a");
        assertThat(breaker.get("state").asText()).isEqualTo("CLOSED");
        assertThat(breaker.get("failed_calls").asInt()).isZero();
    }

    @Test
    void analyticsSummarizesTheMerchantsOwnPaymentsOnly() {
        Keys keys = signup();
        Keys other = signup();
        capturedPayment(other, 99900);

        String first = capturedPayment(keys, 50000);
        capturedPayment(keys, 30000);
        String declinedOrder = createOrder(keys, Map.of("amount", 20000)).get("id").asText();
        assertThat(pay(keys, declinedOrder, Map.of("method", "upi", "vpa", "failure@gateway")).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(as(keys).postForEntity("/v1/payments/" + first + "/refund", Map.of("amount", 10000), JsonNode.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        JsonNode analytics = as(keys).getForObject("/v1/analytics", JsonNode.class);
        assertThat(analytics.get("payments").asLong()).isEqualTo(3);
        assertThat(analytics.get("successful_payments").asLong()).isEqualTo(2);
        assertThat(analytics.get("failed_payments").asLong()).isEqualTo(1);
        assertThat(analytics.get("success_rate").asDouble()).isEqualTo(66.7);
        assertThat(analytics.get("gross_volume").asLong()).isEqualTo(80000);
        assertThat(analytics.get("captured_volume").asLong()).isEqualTo(80000);
        assertThat(analytics.get("refunded_volume").asLong()).isEqualTo(10000);
        // Fee = 2% + 18% GST on it, per captured payment: (1000 + 180) + (600 + 108).
        assertThat(analytics.get("fees").asLong()).isEqualTo(1888);
        assertThat(analytics.get("taxes").asLong()).isEqualTo(288);
        assertThat(analytics.get("net_settlement").asLong()).isEqualTo(80000 - 10000 - 1888);
        assertThat(analytics.get("average_payment_value").asLong()).isEqualTo(40000);
        assertThat(analytics.get("count_by_method").get("upi").asLong()).isEqualTo(3);
        assertThat(analytics.get("count_by_status").get("failed").asLong()).isEqualTo(1);

        assertThat(http.getForEntity("/v1/analytics", JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void theDashboardOriginMayCallTheApiFromABrowser() throws Exception {
        // java.net.HttpURLConnection (behind TestRestTemplate) silently drops Origin headers, so use java.net.http.
        HttpClient client = HttpClient.newHttpClient();
        String url = http.getRootUri() + "/v1/payments";

        HttpResponse<String> allowed = client.send(HttpRequest.newBuilder(URI.create(url))
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .header("Origin", "http://localhost:3000")
                .header("Access-Control-Request-Method", "GET")
                .header("Access-Control-Request-Headers", "authorization")
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(allowed.statusCode()).isEqualTo(200);
        assertThat(allowed.headers().firstValue("Access-Control-Allow-Origin")).contains("http://localhost:3000");

        // A 401 still carries CORS headers, so the dashboard can show "wrong keys" instead of a network error.
        HttpResponse<String> unauthorized = client.send(HttpRequest.newBuilder(URI.create(url))
                .header("Origin", "http://localhost:3000").GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(unauthorized.statusCode()).isEqualTo(401);
        assertThat(unauthorized.headers().firstValue("Access-Control-Allow-Origin")).contains("http://localhost:3000");

        HttpResponse<String> evil = client.send(HttpRequest.newBuilder(URI.create(url))
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .header("Origin", "https://evil.example")
                .header("Access-Control-Request-Method", "GET")
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(evil.statusCode()).isEqualTo(403);
    }

    private JsonNode breaker(String providerId) {
        JsonNode list = http.getForObject("/ops/circuit-breakers", JsonNode.class);
        for (JsonNode item : list.get("items")) {
            if (item.get("provider_id").asText().equals(providerId)) {
                return item;
            }
        }
        throw new AssertionError("No breaker for " + providerId);
    }

    private List<JsonNode> attempts(Keys keys, String paymentId) {
        JsonNode body = as(keys).getForObject("/v1/payments/" + paymentId + "/attempts", JsonNode.class);
        List<JsonNode> items = new ArrayList<>();
        body.get("items").forEach(items::add);
        return items;
    }
}
