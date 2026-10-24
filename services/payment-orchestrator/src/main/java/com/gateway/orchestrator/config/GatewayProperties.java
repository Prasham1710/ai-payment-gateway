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
    }

    @Data
    public static class Pricing {
        /** Platform fee charged on every captured payment. */
        private BigDecimal feePercent = new BigDecimal("2.00");
        /** GST levied on the platform fee. */
        private BigDecimal gstPercent = new BigDecimal("18.00");
    }

    @Data
    public static class Webhooks {
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
        private int batchSize = 50;
    }
}
