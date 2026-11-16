-- 未读计数校准：一次性把会话表的两列未读对齐到"可见未读消息的实际条数"。
--
-- 背景：旧逻辑在"对方正好在房间里"时不累加未读，而对方一旦在推送到达前断开，
-- 库里留下 is_read=0 的消息、会话计数却是 0，红点再也不出现。
-- 代码改为"入库即累加、只有 markRead 清零"之后，历史会话仍需对齐一次。
--
-- 执行时机：与 T4 同批发布时执行一次即可（可与应用发布同窗口，先发布后执行更稳妥：
-- 旧代码运行期间仍可能产生新的漏记，发布完成后执行不会漏）。
--
-- 回退：本脚本只重算两列计数，不影响消息的 is_read；如需处理回退后的行为，
-- 重新执行一次即可。执行前建议先备份，并记录执行前的两列合计值用于核对。

-- 执行前记录（人工保存，便于与新值对比）
-- SELECT SUM(user_unread), SUM(doctor_unread) FROM consult_session;

UPDATE consult_session s
SET s.user_unread = (SELECT COUNT(*) FROM consult_message m
                     WHERE m.session_id = s.id AND m.hidden = 0 AND m.is_read = 0
                       AND m.sender_role = 'DOCTOR'),
    s.doctor_unread = (SELECT COUNT(*) FROM consult_message m
                       WHERE m.session_id = s.id AND m.hidden = 0 AND m.is_read = 0
                         AND m.sender_role = 'USER'),
    s.update_time = NOW();

-- 执行后核对：以下查询必须返回 0 行（SYSTEM 消息 is_read 恒 1，天然不计入）
-- SELECT s.id, s.user_unread, s.doctor_unread FROM consult_session s
--  WHERE s.user_unread <> (SELECT COUNT(*) FROM consult_message m
--          WHERE m.session_id = s.id AND m.hidden = 0 AND m.is_read = 0 AND m.sender_role = 'DOCTOR')
--     OR s.doctor_unread <> (SELECT COUNT(*) FROM consult_message m
--          WHERE m.session_id = s.id AND m.hidden = 0 AND m.is_read = 0 AND m.sender_role = 'USER');
