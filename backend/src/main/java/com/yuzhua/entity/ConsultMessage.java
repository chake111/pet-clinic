package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 问诊聊天消息。对应表 consult_message。
 * 只追加、不删除；管理员屏蔽会更新 hidden_* 三列——用显式业务列而不是 deleted，
 * 全局逻辑删除会把被屏蔽行从管理员审计视图里也藏掉。因此本表没有 update_time / deleted 列。
 */
@Data
@TableName("consult_message")
public class ConsultMessage {

    public static final String ROLE_USER = "USER";
    public static final String ROLE_DOCTOR = "DOCTOR";
    public static final String ROLE_SYSTEM = "SYSTEM";

    public static final String TYPE_TEXT = "TEXT";
    public static final String TYPE_IMAGE = "IMAGE";
    public static final String TYPE_SYSTEM = "SYSTEM";
    /** 医生建议到院预约：患者侧渲染成一张带「去预约挂号」按钮的卡片 */
    public static final String TYPE_SUGGEST = "SUGGEST";

    /** 管理员屏蔽标记：参与方不可见被屏蔽内容，管理员审计视图仍可见 */
    public static final int HIDE_NO = 0;
    public static final int HIDE_YES = 1;

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    /** 系统消息为 0 */
    private Long senderId;
    /** USER / DOCTOR / SYSTEM */
    private String senderRole;
    private String senderName;
    private String senderAvatar;
    /** TEXT / IMAGE / SYSTEM / SUGGEST */
    private String msgType;
    /** 图片消息时存 URL */
    private String content;
    private Integer isRead;

    /** 管理员屏蔽：0 正常 1 已屏蔽（hidden_* 三列留痕） */
    private Integer hidden;
    private String hiddenReason;
    private Long hiddenBy;
    private LocalDateTime hiddenTime;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
}
