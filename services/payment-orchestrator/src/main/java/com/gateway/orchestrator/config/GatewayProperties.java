package com.gateway.orchestrator.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

@Data
@ConfigurationProperties(prefix = "gateway")
public class GatewayProperties {

    private Security security = new Security();
    private Routing routing = new Routing();
    private Pricing pricing = new Pricing();
    private Payments payments = new Payments();
    private Reconciliation reconciliation = new Reconciliation();
    private Webhooks webhooks = new Webhooks();
    private Refunds refunds = new Refunds();

    @Data
    public static class Security {
        /** Base64-encoded 256-bit AES key used to encrypt merchant key secrets and webhook secrets at rest. */
        private String masterKey;
    }

    @Data
    public static class Routing {
        /** Provider rails tried in order; the next one is used only when the current rail is unavailable. */
        private List<String> providers = List.of("provider-a", "provider-b", "provider-c");
        private Duration connectTimeout = Duration.ofSeconds(2);
        private Duration readTimeout = Duration.ofSeconds(8);
        private Ai ai = new Ai();
    }

    @Data
    public static class Ai {
        /** Ask the AI router (services/ai-router) for the rail order; falls back to {@code providers} order. */
        private boolean enabled = true;
        private String baseUrl = "http://localhost:8000";
        /** Hard deadline for routing advice; past it the configured order is used. */
        private Duration timeout = Duration.ofMillis(150);
    }

    @Data
    public static class Pricing {
        /** Platform fee charged on every captured payment. */
        private BigDecimal feePercent = new BigDecimal("2.00");
        /** GST levied on the platform fee. */
        private BigDecimal gstPercent = new BigDecimal("18.00");
    }

    @Data
    public static class Payments {
        /** Authorized payments not captured within this window are refunded automatically. */
        private Duration captureWindow = Duration.ofDays(5);
        /** Wait this long after an automatic refund failed before trying again. */
        private Duration autoRefundRetryInterval = Duration.ofHours(1);
        private int batchSize = 50;
    }

    @Data
    public static class Reconciliation {
        /** How long the gateway keeps asking the bank about a payment whose outcome is unknown. */
        private Duration window = Duration.ofHours(24);
        private int batchSize = 50;
    }

    @Data
    public static class Webhooks {
        /**
         * Allow webhook URLs that resolve to loopback, private or link-local addresses. Off by default
         * so merchants cannot make the gateway call internal services (SSRF); enable for local testing.
         */
        private boolean allowPrivateNetwork = false;
        private int maxEndpointsPerMerchant = 10;
        /** Deliveries one endpoint may have queued or in flight, so a dead endpoint only delays itself. */
        private int maxInFlightPerEndpoint = 2;
        /** Deliveries one merchant may have queued or in flight across endpoints, so no merchant can take every sender. */
        private int maxInFlightPerMerchant = 4;
        /** Deliveries sent in parallel. */
        private int concurrency = 16;
        private int maxAttempts = 8;
        private Duration baseBackoff = Duration.ofSeconds(5);
        private Duration maxBackoff = Duration.ofHours(1);
        private Duration timeout = Duration.ofSeconds(5);
        private int batchSize = 50;
    }

    @Data
    public static class Refunds {
        private int maxAttempts = 10;
        private Duration retryBackoff = Duration.ofSeconds(30);
        /** Retry interval once attempts are exhausted but the bank may have processed the refund. */
        private Duration unconfirmedRetryInterval = Duration.ofHours(1);
        private int batchSize = 50;
    }
}
