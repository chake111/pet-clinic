package com.yuzhua.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 医生列表筛选条件。用户端"找医生"和后台"医生管理"共用。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class DoctorQuery extends PageQuery {

    private Long departmentId;

    /** 命中姓名或擅长领域 */
    private String keyword;

    /**
     * 排序：default 按后台 sort 字段；rating 好评优先；appointment 接诊量优先。
     * 只接受这三个值，避免前端拼出任意 order by。
     */
    private String sort;

    /** 仅后台用：0 停诊 1 正常 */
    private Integer status;
}
