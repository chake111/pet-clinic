package com.yuzhua.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;

import java.time.LocalDate;

/**
 * 病历书写 / 修订的请求体。
 *
 * 预约、宠物、医生、科室、就诊日期与编号都由预约单推导，不接受前端传值；
 * 复诊日期的"是否提交"标记放在表单里：省略表示不改，显式 null 表示清空。
 */
@Data
public class MedicalRecordForm {

    private String chiefComplaint;
    private String physicalExam;
    private String diagnosis;
    private String prescription;
    private String treatment;
    private String advice;
    private LocalDate nextVisitDate;
    private String images;

    @JsonIgnore
    private boolean nextVisitDateSubmitted;

    public void setNextVisitDate(LocalDate date) {
        this.nextVisitDate = date;
        this.nextVisitDateSubmitted = true;
    }
}
