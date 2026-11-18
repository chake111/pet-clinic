package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 问诊会话。对应表 consult_session。图文问诊不建订单，
 * 患者选宠物、填症状后直接在此表落一行；appointment_id 只留给历史数据。
 * 本表无 deleted 列。
 */
@Data
@TableName("consult_session")
public class ConsultSession {

    public static final int ST_PENDING = 0;
    public static final int ST_ACTIVE = 1;
    public static final int ST_CLOSED = 2;

    /** 管理员处置轴，与 status 的诊疗生命周期正交；非 MV_NORMAL 时参与方视同会话不存在 */
    public static final int MV_NORMAL = 0;
    public static final int MV_INVALID = 1;
    public static final int MV_VIOLATION = 2;

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 历史遗留：早期图文问诊挂在预约单下时有值，新会话为 null */
    private Long appointmentId;
    private Long userId;
    private Long doctorId;
    private Long petId;

    /** 发起时填的症状描述 */
    private String symptom;
    /** 逗号分隔的图片 URL，最多 6 张 */
    private String images;

    /** 问诊小结：医生结束会话时给的一段结论/建议。线上只建议、确诊要面诊 */
    private String summary;

    private Integer status;

    /** 管理员处置：0 正常 1 无效关闭 2 违规屏蔽（moderate_* 四列留痕，照 appointment 的 cancel_*） */
    private Integer moderateStatus;
    private String moderateReason;
    /** 处置人 admin_user.id；不做名字回查，不为治理动作引入 join */
    private Long moderateBy;
    private LocalDateTime moderateTime;

    private String lastMessage;
    private LocalDateTime lastMessageTime;
    private Integer userUnread;
    private Integer doctorUnread;
    private LocalDateTime startTime;
    private LocalDateTime endTime;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
}
