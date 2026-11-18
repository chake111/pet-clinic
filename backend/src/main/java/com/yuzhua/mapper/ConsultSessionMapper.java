package com.yuzhua.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.yuzhua.entity.ConsultSession;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;

public interface ConsultSessionMapper extends BaseMapper<ConsultSession> {

    /**
     * 锁定一条会话行。问诊的写操作（发送/接诊/结束/已读/处置）都必须先拿到这把锁，
     * 锁内再读状态、写消息、更摘要，保证同一会话内的提交顺序与摘要顺序一致。
     * 必须在事务内调用。
     */
    @Select("SELECT * FROM consult_session WHERE id = #{sessionId} FOR UPDATE")
    ConsultSession selectByIdForUpdate(@Param("sessionId") Long sessionId);

    /**
     * 收到新消息时刷新会话摘要与未读角标。
     * byDoctor=true 表示发送方是医生，所以未读加在用户侧。
     * countUnread 只用于区分系统消息（is_read 恒 1，不该制造红点）；
     * 参与方消息一律累加，与对方是否在线无关——清零只由 markRead 在同一把会话行锁内完成。
     */
    @Update("""
            UPDATE consult_session SET
              last_message = #{preview},
              last_message_time = NOW(),
              user_unread   = user_unread   + IF(#{byDoctor} AND #{countUnread}, 1, 0),
              doctor_unread = doctor_unread + IF(NOT #{byDoctor} AND #{countUnread}, 1, 0),
              update_time = NOW()
            WHERE id = #{sessionId}
            """)
    int touchOnMessage(@Param("sessionId") Long sessionId,
                       @Param("preview") String preview,
                       @Param("byDoctor") boolean byDoctor,
                       @Param("countUnread") boolean countUnread);

    @Update("UPDATE consult_session SET user_unread = 0, update_time = NOW() WHERE id = #{sessionId}")
    int clearUserUnread(@Param("sessionId") Long sessionId);

    @Update("UPDATE consult_session SET doctor_unread = 0, update_time = NOW() WHERE id = #{sessionId}")
    int clearDoctorUnread(@Param("sessionId") Long sessionId);

    /**
     * 屏蔽/恢复消息后按剩余可见消息重算两侧未读。
     * is_read 是单标志（对方读过即置 1），故 user_unread = 医生发的未读、doctor_unread = 用户发的未读；
     * SYSTEM 消息 is_read 恒 1，天然不计。Wrapper 查询吃不到 hidden 过滤，这里必须手写。
     */
    @Update("""
            UPDATE consult_session SET
              user_unread = (SELECT COUNT(*) FROM consult_message m
                             WHERE m.session_id = #{sessionId} AND m.hidden = 0 AND m.is_read = 0
                               AND m.sender_role = 'DOCTOR'),
              doctor_unread = (SELECT COUNT(*) FROM consult_message m
                               WHERE m.session_id = #{sessionId} AND m.hidden = 0 AND m.is_read = 0
                                 AND m.sender_role = 'USER'),
              update_time = NOW()
            WHERE id = #{sessionId}
            """)
    int refreshUnread(@Param("sessionId") Long sessionId);

    /** 处置后回写会话摘要：被屏蔽的消息不能继续挂在列表上；全被屏蔽时传 null（NULL 排序沉底） */
    @Update("""
            UPDATE consult_session SET
              last_message = #{preview}, last_message_time = #{time}, update_time = NOW()
            WHERE id = #{sessionId}
            """)
    int setLastMessage(@Param("sessionId") Long sessionId,
                       @Param("preview") String preview,
                       @Param("time") LocalDateTime time);
}
