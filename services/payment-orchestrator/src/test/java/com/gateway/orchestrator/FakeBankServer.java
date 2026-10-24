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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * In-process stand-in for the Go bank simulator (same JSON contract), plus a webhook receiver.
 * Each provider rail can be switched between approving, declining and being down.
 */
public class FakeBankServer implements AutoCloseable {

    public enum Mode { APPROVE, DECLINE, DOWN }

    public record ReceivedWebhook(String body, String signature, String eventId, String event) {
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final HttpServer server;
    private final Map<String, Mode> modes = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> chargeCalls = new ConcurrentHashMap<>();
    private final Map<String, String> refundArns = new ConcurrentHashMap<>();
    private final List<ReceivedWebhook> webhooks = new CopyOnWriteArrayList<>();
    private volatile boolean refundsDown;
    private volatile int webhookStatus = 200;

    public FakeBankServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/bank/charge", this::charge);
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
        refundsDown = false;
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

    public void setRefundsDown(boolean down) {
        this.refundsDown = down;
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
        if ("failure@gateway".equals(req.path("customer_vpa").asText()) || "0002".equals(req.path("card_last4").asText())) {
            mode = mode == Mode.DOWN ? Mode.DOWN : Mode.DECLINE;
        }
        String txId = req.path("transaction_id").asText();
        switch (mode) {
            case DOWN -> respond(exchange, 503, Map.of("transaction_id", txId, "provider_id", provider, "status", "FAILED",
                    "response_code", "503", "message", "Provider rail unavailable"));
            case DECLINE -> respond(exchange, 400, Map.of("transaction_id", txId, "provider_id", provider, "status", "FAILED",
                    "response_code", "51", "message", "Declined by issuing bank (Insufficient funds)"));
            case APPROVE -> respond(exchange, 200, Map.of("transaction_id", txId, "provider_id", provider, "status", "SUCCESS",
                    "bank_reference", "BANKREF_" + txId, "response_code", "00", "message", "Transaction Approved"));
        }
    }

    private void refund(HttpExchange exchange) throws IOException {
        JsonNode req = MAPPER.readTree(exchange.getRequestBody());
        if (refundsDown) {
            respond(exchange, 503, Map.of("message", "Provider rail unavailable"));
            return;
        }
        String refundId = req.path("refund_id").asText();
        String arn = refundArns.computeIfAbsent(refundId, id -> "ARN_" + id);
        respond(exchange, 200, Map.of("refund_id", refundId, "provider_id", req.path("provider_id").asText(),
                "status", "PROCESSED", "bank_reference", arn, "response_code", "00", "message", "Refund processed"));
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

    @Override
    public void close() {
        server.stop(0);
    }
}
