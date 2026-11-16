package com.petclinic.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;

/**
 * 单条排班<strong>录入</strong>。
 *
 * 修改另用 {@link ScheduleEditForm}：那个表单没有 status，停诊与恢复只走
 * {@code PUT /admin/schedule/{id}/stop} 与 {@code /resume}。
 */
@Data
public class ScheduleForm {

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

    /**
     * 0 停诊 1 正常，仅新建时生效（不传按正常）；修改排班改不了这一列。
     *
     * <p>越界值必须在入口拦住：新建是 status 现在仅剩的外部写入点，一条 status=2 的排班
     * 会变成既不正常也不像停诊的脏行——可预约查询按 {@code status = 1} 找不到它，
     * 列表又因为 {@code status !== 1} 把它当成停诊去走"恢复"。
     */
    @Min(value = 0, message = "状态只能是 0 停诊或 1 正常")
    @Max(value = 1, message = "状态只能是 0 停诊或 1 正常")
    private Integer status;
}
