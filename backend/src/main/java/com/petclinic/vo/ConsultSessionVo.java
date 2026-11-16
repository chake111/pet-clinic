package com.petclinic.vo;

import com.petclinic.entity.ConsultSession;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 问诊会话列表行。会话表里只有三个外键，聊天列表要显示
 * "谁的哪只宠物、问的哪位医生"，所以在这里拼好。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class ConsultSessionVo extends ConsultSession {

    private String petName;
    private String doctorName;
    private String doctorAvatar;
    private String userNickname;
    private String userPhone;

    /** 按当前登录人取对应那一侧的未读数，省得前端判断身份 */
    private Integer myUnread;
}
