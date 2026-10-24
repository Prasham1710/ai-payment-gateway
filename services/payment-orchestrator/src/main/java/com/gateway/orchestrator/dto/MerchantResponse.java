package com.gateway.orchestrator.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class MerchantResponse {
    private String id;
    @Builder.Default
    private String entity = "merchant";
    private String name;
    private String email;
    private String keyId;
    /** Only returned once, when the account is created. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @ToString.Exclude
    private String keySecret;
    private long createdAt;
}
