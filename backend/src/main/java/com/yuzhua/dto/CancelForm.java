package com.yuzhua.dto;

import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 取消预约。理由可空（用户手滑取消了也要能退），但落库前会去掉空白。
 */
@Data
public class CancelForm {

    @Size(max = 200, message = "取消原因不超过 200 字")
    private String reason;
}
