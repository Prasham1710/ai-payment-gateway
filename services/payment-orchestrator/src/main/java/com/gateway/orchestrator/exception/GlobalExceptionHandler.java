package com.gateway.orchestrator.exception;

import com.gateway.orchestrator.dto.ErrorResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    @ExceptionHandler(GatewayException.class)
    public ResponseEntity<ErrorResponse> handleGateway(GatewayException e) {
        return ResponseEntity.status(e.getStatus()).body(ErrorResponse.from(e));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleUnreadable(HttpMessageNotReadableException e) {
        if (e.getCause() instanceof UnrecognizedPropertyException unknown) {
            return handleGateway(GatewayException.badRequest(unknown.getPropertyName() + " is not a valid field for this request.",
                    unknown.getPropertyName()));
        }
        return handleGateway(GatewayException.badRequest("The request body is not valid JSON or has a field of the wrong type."));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ErrorResponse> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return handleGateway(GatewayException.badRequest("The " + e.getName() + " parameter has an invalid value.", e.getName()));
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ErrorResponse> handleConflict(DataIntegrityViolationException e) {
        log.warn("Data integrity violation: {}", e.getMostSpecificCause().getMessage());
        return handleGateway(GatewayException.conflict("The request conflicts with an existing resource. Retry the request."));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception e) {
        // Spring MVC's own errors (unknown route, 405, 415, missing parameter, ...) keep their status code.
        if (e instanceof org.springframework.web.ErrorResponse springError) {
            HttpStatusCode status = springError.getStatusCode();
            String description = status.value() == 404 ? "The requested URL was not found on the server." : e.getMessage();
            return handleGateway(new GatewayException(HttpStatus.valueOf(status.value()), GatewayException.BAD_REQUEST_ERROR,
                    description, null, null, null, null, null));
        }
        log.error("Unhandled error", e);
        return handleGateway(new GatewayException(HttpStatus.INTERNAL_SERVER_ERROR, GatewayException.SERVER_ERROR,
                "The server encountered an error. The incident has been reported to admins.",
                null, null, null, null, null));
    }
}
