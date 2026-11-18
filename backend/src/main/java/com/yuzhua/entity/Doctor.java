package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 医生（院内员工花名册，非入驻制）。对应表 doctor。
 */
@Data
@TableName("doctor")
public class Doctor {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;
    private String avatar;
    private Integer gender;

    /** 仅后台可见，用户端 VO 不下发 */
    private String phone;

    private String title;
    private Long departmentId;
    /** 逗号分隔 */
    private String specialty;
    private String introduction;
    private Integer workYears;
    private BigDecimal consultationFee;

    /** 由评价聚合回填，非手工维护 */
    private BigDecimal rating;
    private Integer reviewCount;
    private Integer appointmentCount;

    /** 0 离线 1 在线，由 WebSocket 连接数维护 */
    private Integer onlineStatus;

    /** 0 停诊 1 正常 */
    private Integer status;
    private Integer sort;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
