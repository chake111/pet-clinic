package com.petclinic.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 医生评价。对应表 doctor_review，一单一评（appointment_id 唯一）。
 * reply / replyTime 即"商家回复"，参考 chongwuhospital 的 huifupinglun。
 */
@Data
@TableName("doctor_review")
public class DoctorReview {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long appointmentId;
    private Long userId;
    private Long doctorId;
    private Long departmentId;

    /** 综合 1-5 */
    private Integer rating;
    /** 服务态度 1-5 */
    private Integer attitudeScore;
    /** 诊疗效果 1-5 */
    private Integer effectScore;

    private String content;
    private String images;
    private Integer isAnonymous;
    private String reply;
    private LocalDateTime replyTime;
    /** 0 隐藏 1 显示 */
    private Integer status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
