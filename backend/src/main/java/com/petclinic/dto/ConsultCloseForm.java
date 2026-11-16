package com.petclinic.dto;

import lombok.Data;

/** 结束问诊入参：医生可附一段问诊小结，患者关闭待接诊会话时不用传 */
@Data
public class ConsultCloseForm {

    private String summary;
}
