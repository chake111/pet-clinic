package com.yuzhua.dto;

import jakarta.validation.constraints.Min;
import lombok.Data;
import lombok.EqualsAndHashCode;

@Data
@EqualsAndHashCode(callSuper = true)
public class ConsultMessageQuery extends PageQuery {
    /** 只查询比此消息更早的记录；不传则保留原页码分页。 */
    @Min(value = 1, message = "beforeId 必须为正数")
    private Long beforeId;
}
