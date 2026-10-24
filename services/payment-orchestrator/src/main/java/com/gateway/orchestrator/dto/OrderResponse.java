package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderResponse {
    private String id;
    @Builder.Default
    private String entity = "order";
    private long amount;
    private long amountPaid;
    private long amountDue;
    private String currency;
    private String receipt;
    private String status;
    private int attempts;
    private Map<String, String> notes;
    private long createdAt;
}
