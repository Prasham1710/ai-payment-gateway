package com.gateway.orchestrator.support;

import com.gateway.orchestrator.exception.GatewayException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

import java.time.Instant;

/** Razorpay-style list filters: {@code count} (1-100, default 10), {@code skip}, {@code from}/{@code to} as unix seconds. */
public record ListParams(int count, int skip, Instant from, Instant to) {

    private static final int DEFAULT_COUNT = 10;
    private static final int MAX_COUNT = 100;
    // Far enough in the future for "no upper bound", while still a valid SQL timestamp.
    private static final Instant MAX_TIME = Instant.parse("9999-12-31T23:59:59Z");

    public static ListParams of(Integer count, Integer skip, Long from, Long to) {
        int c = count == null ? DEFAULT_COUNT : count;
        if (c < 1 || c > MAX_COUNT) {
            throw GatewayException.badRequest("count must be between 1 and " + MAX_COUNT, "count");
        }
        int s = skip == null ? 0 : skip;
        if (s < 0) {
            throw GatewayException.badRequest("skip must not be negative", "skip");
        }
        Instant fromTime = from == null ? Instant.EPOCH : timestamp(from, "from");
        Instant toTime = to == null ? MAX_TIME : timestamp(to, "to");
        if (fromTime.isAfter(toTime)) {
            throw GatewayException.badRequest("from must be less than or equal to to", "from");
        }
        return new ListParams(c, s, fromTime, toTime);
    }

    private static Instant timestamp(long epochSeconds, String field) {
        if (epochSeconds < 0 || epochSeconds > MAX_TIME.getEpochSecond()) {
            throw GatewayException.badRequest(field + " must be a unix timestamp in seconds.", field);
        }
        return Instant.ofEpochSecond(epochSeconds);
    }

    /** Newest first, with the id as a tie-breaker so paging is stable for rows created in the same instant. */
    public Pageable pageable() {
        return new OffsetPageRequest(skip, count, Sort.by(Sort.Direction.DESC, "createdAt", "id"));
    }
}
