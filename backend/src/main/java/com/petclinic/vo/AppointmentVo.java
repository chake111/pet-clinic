package com.petclinic.vo;

import com.petclinic.entity.Appointment;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.time.LocalDateTime;

/**
 * 预约订单展示对象。列表页要一次显示"谁的哪只宠物、约了哪个科室哪位医生"，
 * 这些名字都在别的表里，所以在服务端拼好，不让前端为每行发五个请求。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class AppointmentVo extends Appointment {

    private String petName;
    private String petSpecies;
    private String petBreed;
    private String petAvatar;

    private String doctorName;
    private String doctorTitle;
    private String doctorAvatar;
    private String departmentName;

    /** 待支付倒计时用；超过这个时间点订单会被清扫任务取消并回滚号源 */
    private LocalDateTime payDeadline;

    /** 在线问诊的会话 id，前端据此判断能否进聊天室 */
    private Long sessionId;

    /** 完成后回填，前端据此决定"写病历/看病历"按钮 */
    private Long recordId;

    /** 患者侧信息只给医生/管理员视图，用户自己的列表不填 */
    private String userNickname;
    private String userPhone;
}
