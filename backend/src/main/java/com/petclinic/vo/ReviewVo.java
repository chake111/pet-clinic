package com.petclinic.vo;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.petclinic.entity.DoctorReview;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.time.LocalDate;

/**
 * 评价展示对象：把评价人昵称冗余出来，并对匿名评价做脱敏。
 * userId 一并屏蔽，前端拿不到也就没法拿它去猜别人是谁。
 */
@Data
@EqualsAndHashCode(callSuper = true)
@JsonIgnoreProperties({"userId"})
public class ReviewVo extends DoctorReview {

    private String userNickname;
    private String userAvatar;

    /** 后台按医生筛选时要能对上号，公开展示不依赖这两个字段 */
    private String doctorName;
    private String doctorTitle;

    /**
     * 评价指向的预约单。只给后台：主键 appointmentId 对管理员没有识别意义，
     * 订单号、就诊日期和宠物名才能回答“这条评价是哪一次就诊”。
     */
    private String orderNo;
    private LocalDate appointmentDate;
    private String petName;
    private String petSpecies;

    /** 匿名时只保留宠物那一侧的信息，评价人身份整体抹掉 */
    public void maskAnonymous() {
        if (!Integer.valueOf(1).equals(getIsAnonymous())) {
            return;
        }
        setUserNickname("匿名用户");
        setUserAvatar(null);
    }
}
