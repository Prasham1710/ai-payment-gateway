package com.gateway.orchestrator.dto;

import lombok.*;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CaptureRequest {
    /** Must equal the authorized amount, in paise. */
    private Long amount;
    private String currency;
}
