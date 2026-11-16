package com.petclinic.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

/**
 * 提交评价。一单一评，appointmentId 是数据库唯一键，重复提交会被拦下。
 */
@Data
public class ReviewForm {

    @NotNull(message = "缺少预约单")
    private Long appointmentId;

    @NotNull(message = "请打分")
    @Min(value = 1, message = "评分为 1-5 星")
    @Max(value = 5, message = "评分为 1-5 星")
    private Integer rating;

    /** 服务态度 1-5，不填按综合分处理 */
    @Min(value = 1, message = "评分为 1-5 星")
    @Max(value = 5, message = "评分为 1-5 星")
    private Integer attitudeScore;

    /** 诊疗效果 1-5 */
    @Min(value = 1, message = "评分为 1-5 星")
    @Max(value = 5, message = "评分为 1-5 星")
    private Integer effectScore;

    @Size(max = 500, message = "评价内容不超过 500 字")
    private String content;

    /** 逗号分隔的就诊体验配图 */
    private String images;

    /** 0 实名 1 匿名 */
    private Integer isAnonymous;
}
