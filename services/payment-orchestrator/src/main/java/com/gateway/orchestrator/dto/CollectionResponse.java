package com.gateway.orchestrator.dto;

import lombok.*;

import java.util.List;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class CollectionResponse<T> {
    private String entity = "collection";
    private int count;
    private List<T> items;

    public static <T> CollectionResponse<T> of(List<T> items) {
        return new CollectionResponse<>("collection", items.size(), items);
    }
}
