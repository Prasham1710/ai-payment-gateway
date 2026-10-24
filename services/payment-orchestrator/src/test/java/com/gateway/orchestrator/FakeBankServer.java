package com.gateway.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * In-process stand-in for the Go bank simulator (same JSON contract), plus a webhook receiver.
 * Each provider rail can be switched between approving, declining, being down, and failing in ways
 * that leave the outcome unknown to the gateway.
 */
public class FakeBankServer implements AutoCloseable {

    public enum Mode {
        APPROVE,
        DECLINE,
        /** 503: the rail did not process the charge. */
        DOWN,
        /** The bank approves the charge but answers 502; the approval only shows up in status enquiries after {@link #settlePendingCharges()}. */
        GATEWAY_ERROR,
        /** The bank approves the charge but answers after {@link #SLOW_MILLIS}, longer than the gateway's read timeout. */
        SLOW
    }

    public enum RefundMode { PROCESS, DOWN, GATEWAY_ERROR }

    public record ReceivedWebhook(String body, String signature, String eventId, String event) {
    }

    public static final long SLOW_MILLIS = 1000;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final HttpServer server;
    private final Map<String, Mode> modes = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> chargeCalls = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Object>> charges = new ConcurrentHashMap<>();
    private final Set<String> unsettledCharges = ConcurrentHashMap.newKeySet();
    private final Map<String, String> refundArns = new ConcurrentHashMap<>();
    private final List<ReceivedWebhook> webhooks = new CopyOnWriteArrayList<>();
    private volatile RefundMode refundMode = RefundMode.PROCESS;
    private volatile int webhookStatus = 200;

    public FakeBankServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/bank/charge", this::charge);
        server.createContext("/api/v1/bank/status", this::status);
        server.createContext("/api/v1/bank/refund", this::refund);
        server.createContext("/hooks", this::webhook);
        server.start();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public void reset() {
        modes.clear();
        chargeCalls.clear();
        webhooks.clear();
        refundMode = RefundMode.PROCESS;
        webhookStatus = 200;
    }

    public void setMode(String provider, Mode mode) {
        modes.put(provider, mode);
    }

    public int chargeCalls(String provider) {
        return chargeCalls.getOrDefault(provider, new AtomicInteger()).get();
    }

    public int totalChargeCalls() {
        return chargeCalls.values().stream().mapToInt(AtomicInteger::get).sum();
    }

    /** Makes charges approved in {@link Mode#GATEWAY_ERROR} visible to status enquiries. */
    public void settlePendingCharges() {
        unsettledCharges.clear();
    }

    public boolean hasCharge(String transactionId) {
        return charges.containsKey(transactionId);
    }

    public void setRefundMode(RefundMode mode) {
        this.refundMode = mode;
    }

    public void setWebhookStatus(int status) {
        this.webhookStatus = status;
    }

    public List<ReceivedWebhook> webhooks() {
        return webhooks;
    }

    private void charge(HttpExchange exchange) throws IOException {
        JsonNode req = MAPPER.readTree(exchange.getRequestBody());
        String provider = req.path("provider_id").asText();
        chargeCalls.computeIfAbsent(provider, p -> new AtomicInteger()).incrementAndGet();
        Mode mode = modes.getOrDefault(provider, Mode.APPROVE);
        if (mode != Mode.DOWN && ("failure@gateway".equals(req.path("customer_vpa").asText()) || "0002".equals(req.path("card_last4").asText()))) {
            mode = Mode.DECLINE;
        }
        String txId = req.path("transaction_id").asText();
        Map<String, Object> approved = Map.of("transaction_id", txId, "provider_id", provider, "status", "SUCCESS",
                "bank_reference", "BANKREF_" + txId, "response_code", "00", "message", "Transaction Approved");
        switch (mode) {
            case DOWN -> respond(exchange, 503, Map.of("transaction_id", txId, "provider_id", provider, "status", "FAILED",
                    "response_code", "503", "message", "Provider rail unavailable"));
            case DECLINE -> {
                Map<String, Object> declined = Map.of("transaction_id", txId, "provider_id", provider, "status", "FAILED",
                        "response_code", "51", "message", "Declined by issuing bank (Insufficient funds)");
                charges.put(txId, declined);
                respond(exchange, 400, declined);
            }
            case APPROVE -> {
                charges.put(txId, approved);
                respond(exchange, 200, approved);
            }
            case GATEWAY_ERROR -> {
                charges.put(txId, approved);
                unsettledCharges.add(txId);
                exchange.sendResponseHeaders(502, -1);
                exchange.close();
            }
            case SLOW -> {
                sleep(SLOW_MILLIS);
                charges.put(txId, approved);
                respond(exchange, 200, approved);
            }
        }
    }

    private void status(HttpExchange exchange) throws IOException {
        String query = exchange.getRequestURI().getQuery();
        String txId = query == null ? "" : query.replace("transaction_id=", "");
        Map<String, Object> charge = charges.get(txId);
        if (charge == null || unsettledCharges.contains(txId)) {
            byte[] body = "Transaction not found in simulator ledger".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/plain");
            exchange.sendResponseHeaders(404, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
            return;
        }
        respond(exchange, 200, charge);
    }

    private void refund(HttpExchange exchange) throws IOException {
        JsonNode req = MAPPER.readTree(exchange.getRequestBody());
        switch (refundMode) {
            case DOWN -> respond(exchange, 503, Map.of("message", "Provider rail unavailable"));
            case GATEWAY_ERROR -> {
                exchange.sendResponseHeaders(502, -1);
                exchange.close();
            }
            case PROCESS -> {
                String refundId = req.path("refund_id").asText();
                String arn = refundArns.computeIfAbsent(refundId, id -> "ARN_" + id);
                respond(exchange, 200, Map.of("refund_id", refundId, "provider_id", req.path("provider_id").asText(),
                        "status", "PROCESSED", "bank_reference", arn, "response_code", "00", "message", "Refund processed"));
            }
        }
    }

    private void webhook(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        webhooks.add(new ReceivedWebhook(body,
                exchange.getRequestHeaders().getFirst("X-Gateway-Signature"),
                exchange.getRequestHeaders().getFirst("X-Gateway-Event-Id"),
                exchange.getRequestHeaders().getFirst("X-Gateway-Event")));
        exchange.sendResponseHeaders(webhookStatus, -1);
        exchange.close();
    }

    private static void respond(HttpExchange exchange, int status, Map<String, ?> body) throws IOException {
        byte[] bytes = MAPPER.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
