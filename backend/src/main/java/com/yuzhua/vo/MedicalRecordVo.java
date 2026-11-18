package com.yuzhua.vo;

import com.yuzhua.entity.MedicalRecord;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 病历详情。打印病历单要同时出现宠物和医生信息，
 * 这些都在别的表里，所以在服务端拼好。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class MedicalRecordVo extends MedicalRecord {

    private String petName;
    private String petSpecies;
    private String petBreed;
    private String petAvatar;
    private String doctorName;
    private String doctorTitle;
    private String departmentName;
}
