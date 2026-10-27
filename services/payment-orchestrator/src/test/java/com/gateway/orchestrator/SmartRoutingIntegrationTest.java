package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.gateway.orchestrator.FakeBankServer.Mode;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** The AI router only reorders the configured rails, and payments never depend on it being up. */
class SmartRoutingIntegrationTest extends IntegrationTestSupport {

    @Test
    void railOrderComesFromTheAiRouterAndOutcomesAreReportedBack() {
        Keys keys = signup();
        BANK.setAiRouter(List.of("provider-c", "provider-a", "provider-b"), 0);

        String paymentId = paidWithRegularUpi(keys, 42000);

        assertThat(attemptProviders(keys, paymentId)).containsExactly("provider-c");
        await().atMost(Duration.ofSeconds(2)).until(() -> feedbackFor(42000).size() == 1);
        JsonNode feedback = feedbackFor(42000).get(0);
        assertThat(feedback.get("provider").asText()).isEqualTo("provider-c");
        assertThat(feedback.get("payment_method").asText()).isEqualTo("UPI");
        assertThat(feedback.get("outcome").asText()).isEqualTo("success");
        assertThat(feedback.get("amount").asLong()).isEqualTo(42000);
    }

    @Test
    void unknownOrDuplicateRailsFromTheRouterAreIgnoredAndNoneAreDropped() {
        Keys keys = signup();
        BANK.setAiRouter(List.of("provider-x", "provider-b", "provider-b"), 0);
        BANK.setMode("provider-b", Mode.DOWN);

        String paymentId = paidWithRegularUpi(keys, 10101);

        // provider-b first as advised; failover continues with the rails the router left out, in configured order.
        assertThat(attemptProviders(keys, paymentId)).containsExactly("provider-b", "provider-a");
        await().atMost(Duration.ofSeconds(2)).until(() -> feedbackFor(10101).size() == 2);
        assertThat(feedbackFor(10101).stream().map(f -> f.get("outcome").asText())).containsExactlyInAnyOrder("unavailable", "success");
    }

    @Test
    void slowOrDownRouterFallsBackToTheConfiguredOrder() {
        Keys keys = signup();
        BANK.setAiRouter(List.of("provider-c", "provider-b", "provider-a"), 1000);   // slower than the 150ms deadline

        long start = System.nanoTime();
        String slow = capturedPayment(keys, 10000);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofMillis(900));
        assertThat(attemptProviders(keys, slow)).containsExactly("provider-a");

        BANK.setAiRouter(null, 0);   // router answers 503
        String down = capturedPayment(keys, 10000);
        assertThat(attemptProviders(keys, down)).containsExactly("provider-a");
    }

    @Test
    void sandboxTestInstrumentOutcomesAreNotReportedButRailOutagesAre() throws InterruptedException {
        Keys keys = signup();
        BANK.setAiRouter(List.of("provider-a", "provider-b", "provider-c"), 0);
        capturedPayment(keys, 31337);   // success@gateway: the bank forces the approval, whatever the rail

        BANK.setMode("provider-a", Mode.DOWN);
        capturedPayment(keys, 31338);   // provider-a is down: that is real information about the rail

        await().atMost(Duration.ofSeconds(2)).until(() -> feedbackFor(31338).size() == 1);
        assertThat(feedbackFor(31338).get(0).get("outcome").asText()).isEqualTo("unavailable");
        Thread.sleep(300);   // feedback is asynchronous: give a wrongly sent report time to arrive
        assertThat(feedbackFor(31337)).isEmpty();
    }

    private String paidWithRegularUpi(Keys keys, long amount) {
        String orderId = createOrder(keys, Map.of("amount", amount)).get("id").asText();
        ResponseEntity<JsonNode> paid = pay(keys, orderId, Map.of("method", "upi", "vpa", "ravi@okaxis"));
        assertThat(paid.getStatusCode()).isEqualTo(HttpStatus.OK);
        return paid.getBody().get("payment_id").asText();
    }

    /** Feedback is sent asynchronously, so tell this test's reports apart by their (unique) amount. */
    private static List<JsonNode> feedbackFor(long amount) {
        return BANK.aiFeedback().stream().filter(f -> f.get("amount").asLong() == amount).toList();
    }

    private List<String> attemptProviders(Keys keys, String paymentId) {
        ResponseEntity<JsonNode> attempts = as(keys).getForEntity("/v1/payments/" + paymentId + "/attempts", JsonNode.class);
        assertThat(attempts.getStatusCode()).isEqualTo(HttpStatus.OK);
        String[] providers = new String[attempts.getBody().get("count").asInt()];
        for (int i = 0; i < providers.length; i++) {
            providers[i] = attempts.getBody().get("items").get(i).get("provider").asText();
        }
        return Arrays.asList(providers);
    }
}
