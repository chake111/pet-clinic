package com.yuzhua.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 预约下单入参。只面向到院门诊；图文问诊免费、不建订单，走 ConsultForm 直建会话。
 *
 * 金额、排队号、科室、日期时段都不接受前端传值，全部由服务端按 scheduleId 反查，
 * 否则前端传 amount=0.01 就能用一分钱占一个专家号。
 */
@Data
public class AppointmentForm {

    @NotNull(message = "请选择就诊宠物")
    private Long petId;

    @NotNull(message = "请选择医生")
    private Long doctorId;

    @NotNull(message = "请选择就诊时段")
    private Long scheduleId;

    @NotNull(message = "请描述症状")
    @Size(max = 500, message = "症状描述不超过 500 字")
    private String symptom;

    /** 逗号分隔的图片 URL，最多 6 张 */
    private String images;
}
