package com.gateway.orchestrator.security;

import com.gateway.orchestrator.config.GatewayProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

class WebhookUrlGuardTest {

    private final WebhookUrlGuard guard = guard(false);

    @ParameterizedTest
    @ValueSource(strings = {
            "http://127.0.0.1:8081/api/v1/chaos/kill",
            "http://localhost:8080/v1/orders",
            "http://10.0.0.5/hook",
            "http://172.16.3.4/hook",
            "http://192.168.1.10/hook",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/hook",
            "http://0.0.0.0/hook",
            "http://[::1]/hook",
            "http://[fd00::1]/hook",
            "http://[::ffff:127.0.0.1]/hook",
            "http://[64:ff9b::a9fe:a9fe]/hook"
    })
    void refusesNonPublicAddresses(String url) {
        assertThat(guard.rejectionReason(URI.create(url))).isNotNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://93.184.216.34/hook", "https://[2606:4700:4700::1111]/hook"})
    void allowsPublicAddresses(String url) {
        assertThat(guard.rejectionReason(URI.create(url))).isNull();
    }

    @Test
    void privateNetworksCanBeAllowedForLocalDevelopment() {
        assertThat(guard(true).rejectionReason(URI.create("http://127.0.0.1:9000/hook"))).isNull();
    }

    private static WebhookUrlGuard guard(boolean allowPrivateNetwork) {
        GatewayProperties properties = new GatewayProperties();
        properties.getWebhooks().setAllowPrivateNetwork(allowPrivateNetwork);
        return new WebhookUrlGuard(properties);
    }
}
