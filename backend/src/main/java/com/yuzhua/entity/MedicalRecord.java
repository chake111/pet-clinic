package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 病历 / 处方。对应表 medical_record，由医生在接诊后填写。
 */
@Data
@TableName("medical_record")
public class MedicalRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String recordNo;
    private Long appointmentId;
    private Long userId;
    private Long petId;
    private Long doctorId;
    private Long departmentId;
    private LocalDate visitDate;

    /** 主诉 */
    private String chiefComplaint;
    /** 体格检查 */
    private String physicalExam;
    /** 诊断结论 */
    private String diagnosis;
    /** 处方/用药建议 */
    private String prescription;
    /** 处置措施 */
    private String treatment;
    /** 医嘱 */
    private String advice;
    private LocalDate nextVisitDate;
    private String images;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
