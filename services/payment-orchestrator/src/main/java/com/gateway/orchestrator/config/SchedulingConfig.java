package com.gateway.orchestrator.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Background workers (webhook dispatcher, refund retries). Tests switch this off and drive the
 * workers directly so that timing never makes them flaky.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(prefix = "gateway.scheduling", name = "enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfig {
}
