package com.petclinic.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;

/**
 * 预约订单。对应表 appointment。
 *
 * 状态机：
 *   0 待接诊 --医生接诊--> 1 已接诊 --结束问诊--> 2 已完成
 *   0/1 --用户或医生取消--> 3 已取消（号源回滚）
 *   0   --超时未到-------> 4 未到诊
 */
@Data
@TableName("appointment")
public class Appointment {

    public static final int ST_PENDING = 0;
    public static final int ST_ACCEPTED = 1;
    public static final int ST_FINISHED = 2;
    public static final int ST_CANCELLED = 3;
    public static final int ST_MISSED = 4;

    public static final int CT_ONLINE = 1;
    public static final int CT_VISIT = 2;

    public static final int PAY_NONE = 0;
    public static final int PAY_PAID = 1;
    public static final int PAY_REFUNDED = 2;

    @TableId(type = IdType.AUTO)
    private Long id;

    private String orderNo;
    private Long userId;
    private Long petId;
    private Long doctorId;
    private Long departmentId;
    private Long scheduleId;

    /** 1 在线图文问诊 2 到院门诊 */
    private Integer consultType;
    private LocalDate appointmentDate;
    private Integer period;
    private LocalTime startTime;
    private LocalTime endTime;
    private Integer queueNo;

    private String symptom;
    /** 逗号分隔 URL */
    private String images;

    private BigDecimal amount;
    private Integer payStatus;
    private LocalDateTime payTime;
    private String payType;
    private Integer status;

    private LocalDateTime acceptTime;
    private LocalDateTime finishTime;
    private String cancelReason;
    private LocalDateTime cancelTime;
    /** USER / DOCTOR / ADMIN / SYSTEM */
    private String cancelBy;
    private Integer isReviewed;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
