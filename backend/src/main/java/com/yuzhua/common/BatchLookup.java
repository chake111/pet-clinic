package com.yuzhua.common;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 列表→id 集合、按 id 批量装载的公共小工具。
 *
 * 原先 AppointmentService.idsOf 与 ConsultService / MedicalRecordService 的
 * ids+mapByIds 是三份等价实现，收敛到这里。无状态纯函数；查库仍由调用方传
 * loader（selectBatchIds 之类），一次批量取，不逐行查。
 */
public final class BatchLookup {

    private BatchLookup() {
    }

    /**
     * 提取行上的外键 ID 并去重。
     *
     * @param rows 待映射的行集合
     * @param fn 外键提取函数，其返回的 null 会被过滤
     * @return 去重后的非 null 外键 ID 集合
     */
    public static <T> Set<Long> ids(Collection<T> rows, Function<T, Long> fn) {
        return rows.stream().map(fn).filter(Objects::nonNull).collect(Collectors.toSet());
    }

    /** selectBatchIds 传空集合会拼出 IN ()，先挡掉 */
    public static <T> Map<Long, T> mapByIds(Function<Set<Long>, List<T>> loader, Set<Long> keys,
                                            Function<T, Long> idFn) {
        if (keys.isEmpty()) {
            return Map.of();
        }
        return loader.apply(keys).stream().collect(Collectors.toMap(idFn, Function.identity()));
    }
}
