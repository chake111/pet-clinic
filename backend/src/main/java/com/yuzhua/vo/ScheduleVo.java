package com.yuzhua.vo;

import com.yuzhua.entity.DoctorSchedule;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.math.BigDecimal;

/**
 * 排班号源，冗余医生信息。后台排班列表和用户端选号页都要显示"谁、几点、多少钱"，
 * 前端不该为每行再查一次医生。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class ScheduleVo extends DoctorSchedule {

    private String doctorName;
    private String doctorTitle;
    private String doctorAvatar;
    private Long departmentId;
    private String departmentName;
    private BigDecimal consultationFee;

    /** 医生当前停诊时为 false，前端把该时段整块置灰 */
    private Boolean doctorAvailable;

    /**
     * 引用过该排班的预约条数（含已取消），仅后台列表填充。
     * 大于 0 即归属冻结：医生/日期/时段不可改、不可删除（I10），前端据此置灰并说明原因。
     */
    private Long refNum;
}
