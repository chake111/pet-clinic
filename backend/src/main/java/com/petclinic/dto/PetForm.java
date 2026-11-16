package com.petclinic.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * 宠物新增 / 编辑的请求体。
 *
 * 只放档案字段；归属 userId、系统时间与逻辑删除不在表单里。
 * birthday / weight 的"是否提交"标记放在这里而不是实体上：编辑时省略字段表示不改，
 * 显式传 null 表示清空，Jackson 只有真正出现该键时才会调用对应 setter。
 */
@Data
public class PetForm {

    private String name;
    private String species;
    private String breed;
    private Integer gender;
    private LocalDate birthday;
    private Integer ageMonth;
    private BigDecimal weight;
    private String color;
    private Integer isNeutered;
    private Integer vaccineStatus;
    private Integer dewormFlag;
    private String avatar;
    private String allergy;
    private String medicalHistory;
    private String remark;

    @JsonIgnore
    private boolean birthdaySubmitted;
    @JsonIgnore
    private boolean weightSubmitted;

    public void setBirthday(LocalDate birthday) {
        this.birthday = birthday;
        this.birthdaySubmitted = true;
    }

    public void setWeight(BigDecimal weight) {
        this.weight = weight;
        this.weightSubmitted = true;
    }
}
