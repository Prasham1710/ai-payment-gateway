package com.gateway.orchestrator.dto;

import lombok.*;
import java.math.BigDecimal;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BankChargeRequest {
    private String transaction_id;
    private String provider_id;
    private BigDecimal amount;
    private String currency;
    private String payment_method;
    private String customer_vpa;
}
