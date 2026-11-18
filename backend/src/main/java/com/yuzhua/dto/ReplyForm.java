package com.yuzhua.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

/**
 * 医生回复评价。字数上限在 Service 里判，和评价正文保持一致的口径。
 */
@Data
public class ReplyForm {

    @NotBlank(message = "请填写回复内容")
    private String reply;
}
