package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class RefundCreateRequest {
    /** In paise. Defaults to the full unrefunded amount. */
    private Long amount;
    private String receipt;
    private Map<String, String> notes;
}
