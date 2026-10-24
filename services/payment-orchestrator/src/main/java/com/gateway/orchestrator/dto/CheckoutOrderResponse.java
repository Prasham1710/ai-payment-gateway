package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CheckoutOrderResponse {
    private String orderId;
    private long amount;
    private String currency;
    private String status;
    private String merchantName;
}
