package com.petclinic.common;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 批量装载工具的空集合、去重与入参传递。
 *
 * <p>空集合直接返回空 Map 是关键：MyBatis-Plus 的 selectBatchIds 收到空集合会拼出 IN ()，
 * 所以调用方不应该靠"先判空"来兜底，工具本身必须挡掉。
 */
class BatchLookupTest {

    record Row(Long ref) {
    }

    record Item(Long id, String name) {
    }

    @Test
    void idsFiltersNullAndDeduplicates() {
        List<Row> rows = List.of(new Row(10L), new Row(10L), new Row(null), new Row(20L));
        assertEquals(Set.of(10L, 20L), BatchLookup.ids(rows, Row::ref));
        assertTrue(BatchLookup.ids(List.<Row>of(), Row::ref).isEmpty());
    }

    @Test
    void emptyKeysDoNotCallLoader() {
        AtomicBoolean called = new AtomicBoolean();
        Map<Long, Item> result = BatchLookup.mapByIds(keys -> {
            called.set(true);
            return List.of();
        }, Set.of(), Item::id);
        assertTrue(result.isEmpty());
        assertFalse(called.get(), "空集合不应触发 selectBatchIds");
    }

    @Test
    void mapsLoaderRowsByIdAndPassesTheSameKeySet() {
        Set<Long> keys = Set.of(1L, 2L);
        List<Set<Long>> seen = new ArrayList<>();
        Map<Long, Item> result = BatchLookup.mapByIds(ids -> {
            seen.add(ids);
            return List.of(new Item(1L, "甲"), new Item(2L, "乙"));
        }, keys, Item::id);

        assertEquals(2, result.size());
        assertEquals("甲", result.get(1L).name());
        assertEquals("乙", result.get(2L).name());
        assertSame(keys, seen.get(0), "loader 应收到调用方传入的同一组编号");
    }
}
