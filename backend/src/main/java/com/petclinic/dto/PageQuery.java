package com.petclinic.dto;

import lombok.Data;

/**
 * 分页查询入参基类。所有列表接口继承它，避免每页重复声明分页字段。
 */
@Data
public class PageQuery {

    private Integer pageNum = 1;
    private Integer pageSize = 10;

    public Integer getPageNum() {
        return pageNum == null || pageNum < 1 ? 1 : pageNum;
    }

    /** 上限 100，防止前端传 size=99999 拖库 */
    public Integer getPageSize() {
        if (pageSize == null || pageSize < 1) {
            return 10;
        }
        return Math.min(pageSize, 100);
    }
}
