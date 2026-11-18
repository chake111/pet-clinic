package com.yuzhua.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 后台病历列表筛选。keyword 命中诊断、主诉或病历号。
 * doctorId 只对管理员有效，医生账号被强制为自己的 id。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class RecordQuery extends PageQuery {

    private Long doctorId;
    private Long petId;
    private String keyword;
}
