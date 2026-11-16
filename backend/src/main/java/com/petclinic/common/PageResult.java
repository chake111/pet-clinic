package com.petclinic.common;

import com.baomidou.mybatisplus.core.metadata.IPage;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.function.Function;

/**
 * 分页结果。字段名 records/total/current/size 与 MyBatis-Plus IPage 对齐，
 * 前端表格直接按这套 key 取数。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class PageResult<T> {

    private List<T> records;
    private long total;
    private long current;
    private long size;
    private long pages;

    public static <T> PageResult<T> of(IPage<T> page) {
        return new PageResult<>(page.getRecords(), page.getTotal(),
                page.getCurrent(), page.getSize(), page.getPages());
    }

    /** 分页对象转换：把实体页映射成 VO 页，保留分页元数据 */
    public static <E, T> PageResult<T> of(IPage<E> page, Function<E, T> mapper) {
        List<T> list = page.getRecords().stream().map(mapper).toList();
        return new PageResult<>(list, page.getTotal(), page.getCurrent(), page.getSize(), page.getPages());
    }

    /**
     * 数据行已在外面批量转换完（需要先查字典避免 N+1）时用这个重载，分页元数据仍取自原 page。
     */
    public static <E, T> PageResult<T> of(IPage<E> page, List<T> records) {
        return new PageResult<>(records, page.getTotal(), page.getCurrent(), page.getSize(), page.getPages());
    }
}
