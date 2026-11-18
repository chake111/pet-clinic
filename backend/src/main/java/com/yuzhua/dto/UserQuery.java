package com.yuzhua.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 后台用户列表筛选条件。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class UserQuery extends PageQuery {

    /** 命中昵称、手机号或登录账号 */
    private String keyword;

    /** 0 禁用 1 正常 */
    private Integer status;
}
