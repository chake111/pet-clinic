package com.yuzhua.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

/**
 * 按周期模板批量排班：一名医生、一段日期区间、勾选的星期几、若干时段模板。
 * 后台逐条点 42 次录入不现实，排班功能实际靠这个接口。
 */
@Data
public class ScheduleBatchForm {

    @NotNull(message = "请选择医生")
    private Long doctorId;

    @NotNull(message = "请选择开始日期")
    private LocalDate startDate;

    @NotNull(message = "请选择结束日期")
    private LocalDate endDate;

    /** ISO 星期几：1 周一 … 7 周日 */
    @NotEmpty(message = "请选择每周几排班")
    private List<Integer> weekDays;

    @Valid
    @NotEmpty(message = "请至少配置一个时段")
    private List<PeriodTemplate> periods;

    @Data
    public static class PeriodTemplate {
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

    /** 号源数全局覆盖：批量生成后想统一加减号时用，为空则按模板各自的号源数 */
    private Integer overrideTotalNum;
}
