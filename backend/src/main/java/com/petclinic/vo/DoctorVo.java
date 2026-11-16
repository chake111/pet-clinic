package com.petclinic.vo;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.petclinic.entity.Doctor;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 用户端医生展示对象。
 *
 * 继承实体而不是重新拷贝一遍字段，是本项目的既定约定（参考 MixPet）；
 * 代价是要显式屏蔽不能下发给浏览者的列——医生手机号只有后台看得到。
 */
@Data
@EqualsAndHashCode(callSuper = true)
@JsonIgnoreProperties({"phone"})
public class DoctorVo extends Doctor {

    /** 科室名冗余给列表卡片用，省掉前端二次查询 */
    private String departmentName;
    private String departmentIcon;
}
