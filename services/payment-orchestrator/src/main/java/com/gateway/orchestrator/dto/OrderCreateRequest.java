package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderCreateRequest {
    /** In paise, e.g. 50000 for INR 500.00. */
    private Long amount;
    private String currency;
    private String receipt;
    private Map<String, String> notes;
    /** Capture payments automatically once authorized (default true). */
    private Boolean paymentCapture;
}
