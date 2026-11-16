package com.petclinic.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * 医生新增 / 编辑的请求体。
 *
 * 只放人工维护的档案字段；评分、评价数、接诊量、在线状态由评价、完成预约和 WebSocket
 * 聚合维护，id、deleted、创建/更新时间由服务端与 MyBatis-Plus 维护，均不在表单里。
 */
@Data
public class DoctorForm {

    private String name;
    private String avatar;
    private Integer gender;
    private String phone;
    private String title;
    private Long departmentId;
    private String specialty;
    private String introduction;
    private Integer workYears;
    private BigDecimal consultationFee;

    /** 0 停诊 1 正常；新增不传按 1，编辑不传保持原值 */
    private Integer status;
    private Integer sort;
}
