package com.yuzhua.dto;

import lombok.Data;

/**
 * 科室新增 / 编辑的请求体。
 *
 * 只放可编辑字段；id、deleted、createTime、updateTime 等系统字段不在表单里，
 * 由服务端与 MyBatis-Plus 填充策略维护。读接口仍返回 Department 实体，保持现有响应结构。
 */
@Data
public class DepartmentForm {

    private String name;
    private String code;
    private String icon;
    private String description;
    private Integer sort;

    /** 0 停用 1 启用；新增不传按 1，编辑不传保持原值 */
    private Integer status;
}
