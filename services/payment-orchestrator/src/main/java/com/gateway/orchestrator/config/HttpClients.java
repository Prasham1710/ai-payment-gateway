package com.gateway.orchestrator.config;

import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;

public final class HttpClients {

    /**
     * Never throws on 4xx/5xx: a bank decline or a webhook receiver error is a normal outcome
     * that callers classify themselves.
     */
    private static final DefaultResponseErrorHandler NO_THROW = new DefaultResponseErrorHandler() {
        @Override
        public boolean hasError(ClientHttpResponse response) {
            return false;
        }
    };

    private HttpClients() {
    }

    public static RestTemplate nonThrowing(RestTemplateBuilder builder, Duration connectTimeout, Duration readTimeout) {
        return builder
                .setConnectTimeout(connectTimeout)
                .setReadTimeout(readTimeout)
                .errorHandler(NO_THROW)
                .build();
    }
}
