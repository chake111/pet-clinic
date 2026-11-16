package com.petclinic.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;

/**
 * 修改排班的请求体。
 *
 * 与 {@link ScheduleForm} 的唯一差别是<strong>没有 status</strong>：排班的停诊/出诊状态
 * 只由 {@code PUT /admin/schedule/{id}/stop} 与 {@code /resume} 写入。
 *
 * 契约动机: 编辑弹窗里的状态单选与专用端点写的是同一列，把一个停留在停诊之前的表单
 * 再提交一次，就会把停诊静默撤销——管理员看到的是"点了停诊，过一会儿自己变回出诊"。
 * 把 status 从编辑契约里删掉，越权写入在反序列化阶段就不成立，不依赖调用方自觉。
 */
@Data
public class ScheduleEditForm {

    @NotNull(message = "请选择医生")
    private Long doctorId;

    @NotNull(message = "请选择排班日期")
    private LocalDate workDate;

    /** 1 上午 2 下午 3 夜间 */
    @NotNull(message = "请选择时段")
    private Integer period;

    @NotNull(message = "请选择开始时间")
    private LocalTime startTime;

    @NotNull(message = "请选择结束时间")
    private LocalTime endTime;

    @NotNull(message = "请填写号源数")
    @Min(value = 1, message = "号源数至少为 1")
    private Integer totalNum;
}
