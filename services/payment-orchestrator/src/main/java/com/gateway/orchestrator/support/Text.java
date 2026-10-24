package com.gateway.orchestrator.support;

public final class Text {

    private Text() {
    }

    /** Cuts external text (bank messages, references) to fit its column instead of failing the write. */
    public static String truncate(String value, int maxLength) {
        return value == null || value.length() <= maxLength ? value : value.substring(0, maxLength);
    }
}
