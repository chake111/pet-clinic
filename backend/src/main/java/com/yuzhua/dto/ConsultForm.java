package com.yuzhua.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 发起图文问诊入参。免费、不占号源、不建订单，
 * 归属由服务端按 petId 反查，医生只校验在诊状态。
 */
@Data
public class ConsultForm {

    @NotNull(message = "请选择问诊宠物")
    private Long petId;

    @NotNull(message = "请选择医生")
    private Long doctorId;

    @NotBlank(message = "请描述症状")
    @Size(max = 500, message = "症状描述不超过 500 字")
    private String symptom;

    /** 逗号分隔的图片 URL，最多 6 张 */
    private String images;
}
