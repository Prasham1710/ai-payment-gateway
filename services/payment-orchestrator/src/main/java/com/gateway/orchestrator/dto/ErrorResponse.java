package com.gateway.orchestrator.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.gateway.orchestrator.exception.GatewayException;
import lombok.*;

import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ErrorResponse {
    private ErrorBody error;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class ErrorBody {
        private String code;
        private String description;
        private String source;
        private String step;
        private String reason;
        @JsonInclude(JsonInclude.Include.NON_NULL)
        private String field;
        private Map<String, Object> metadata;
    }

    public static ErrorResponse from(GatewayException e) {
        return new ErrorResponse(ErrorBody.builder()
                .code(e.getCode())
                .description(e.getDescription())
                .source(e.getSource())
                .step(e.getStep())
                .reason(e.getReason())
                .field(e.getField())
                .metadata(e.getMetadata())
                .build());
    }
}
