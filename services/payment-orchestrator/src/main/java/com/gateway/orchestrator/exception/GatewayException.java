package com.gateway.orchestrator.exception;

import lombok.Getter;
import org.springframework.http.HttpStatus;

import java.util.Map;

/**
 * An API error rendered in Razorpay's error shape:
 * {@code {"error": {"code", "description", "source", "step", "reason", "field", "metadata"}}}.
 */
@Getter
public class GatewayException extends RuntimeException {

    public static final String BAD_REQUEST_ERROR = "BAD_REQUEST_ERROR";
    public static final String GATEWAY_ERROR = "GATEWAY_ERROR";
    public static final String SERVER_ERROR = "SERVER_ERROR";
    public static final String NOT_APPLICABLE = "NA";

    private final HttpStatus status;
    private final String code;
    private final String field;
    private final String source;
    private final String step;
    private final String reason;
    private final Map<String, Object> metadata;

    public GatewayException(HttpStatus status, String code, String description, String field,
                            String source, String step, String reason, Map<String, Object> metadata) {
        super(description);
        this.status = status;
        this.code = code;
        this.field = field;
        this.source = source == null ? NOT_APPLICABLE : source;
        this.step = step == null ? NOT_APPLICABLE : step;
        this.reason = reason == null ? NOT_APPLICABLE : reason;
        this.metadata = metadata == null ? Map.of() : metadata;
    }

    public static GatewayException badRequest(String description) {
        return badRequest(description, null);
    }

    public static GatewayException badRequest(String description, String field) {
        return new GatewayException(HttpStatus.BAD_REQUEST, BAD_REQUEST_ERROR, description, field,
                "business", null, "input_validation_failed", null);
    }

    public static GatewayException notFound(String description) {
        return new GatewayException(HttpStatus.NOT_FOUND, BAD_REQUEST_ERROR, description, "id",
                null, null, null, null);
    }

    public static GatewayException conflict(String description) {
        return new GatewayException(HttpStatus.CONFLICT, BAD_REQUEST_ERROR, description, null,
                "business", null, null, null);
    }

    public static GatewayException unauthorized() {
        return new GatewayException(HttpStatus.UNAUTHORIZED, BAD_REQUEST_ERROR, "Authentication failed", null,
                null, null, null, null);
    }

    public String getDescription() {
        return getMessage();
    }
}
