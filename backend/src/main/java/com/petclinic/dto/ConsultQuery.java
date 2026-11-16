package com.petclinic.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 后台问诊记录筛选条件（管理员只读 + 处置）。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class ConsultQuery extends PageQuery {

    /** 会话状态：0 待接诊 1 进行中 2 已结束 */
    private Integer status;

    /** 处置状态：0 未处置 1 无效关闭 2 违规屏蔽 */
    private Integer moderateStatus;
}
