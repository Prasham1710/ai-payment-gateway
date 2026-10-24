package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class MerchantCreateRequest {
    private String name;
    private String email;
}
