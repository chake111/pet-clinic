-- =====================================================================
--  20260922_add_schedule_queue_counter.sql
--  R1：预约排队序号与号源容量分离
--
--  背景：queue_no 原先在下单时用「总量 - 余量」现场推算。取消会把余量加回去，
--        于是下一单又推算出同一个号，同一排班可能出现重复排队序号。
--  做法：排班表加 last_queue_no 记录「本排班已发放到的最大序号」，占号时在同一条
--        条件更新里随容量一起递增；该值只由服务端维护，取消、停诊、恢复、改容量
--        都不重置，也不接受请求体覆盖。
--
--  执行前提：停写执行一次（列不存在时执行；重复执行会因 Duplicate column 报错，
--            这是预期的防重跑信号，不要改成 IF NOT EXISTS 掩盖）。
--  本脚本不修改任何既有 appointment.queue_no —— 历史重复号单独走数据处置决定。
-- =====================================================================

ALTER TABLE `doctor_schedule`
  ADD COLUMN `last_queue_no` INT NOT NULL DEFAULT 0
  COMMENT '已发放的最大排队序号，只增不减、取消不回收'
  AFTER `remain_num`;

-- 计数器初始化为该排班历史上发过的最大序号。
-- 这里刻意不区分已取消与逻辑删除的预约：这些号确实发放过，
-- 从它们之上继续编号才能保证「不再复用」。
UPDATE `doctor_schedule` s
LEFT JOIN (
    SELECT `schedule_id`, MAX(`queue_no`) AS max_no
    FROM `appointment`
    WHERE `queue_no` IS NOT NULL
    GROUP BY `schedule_id`
) a ON a.`schedule_id` = s.`id`
SET s.`last_queue_no` = IFNULL(a.max_no, 0);

-- ---------------------------------------------------------------------
-- 迁移后自检：三条都应为 0 行才算完成
-- ---------------------------------------------------------------------

-- (1) 有排行的 last_queue_no 必须不小于该排班历史上发过的最大序号
SELECT s.`id`, s.`last_queue_no`, MAX(a.`queue_no`) AS historical_max
FROM `doctor_schedule` s
JOIN `appointment` a ON a.`schedule_id` = s.`id` AND a.`queue_no` IS NOT NULL
GROUP BY s.`id`, s.`last_queue_no`
HAVING s.`last_queue_no` < MAX(a.`queue_no`);

-- (2) 计数器不得为负
SELECT `id`, `last_queue_no` FROM `doctor_schedule` WHERE `last_queue_no` < 0;

-- (3) 无预约的排班计数器必须为 0（新排班也走这条默认值）
SELECT `id`, `last_queue_no` FROM `doctor_schedule` s
WHERE s.`last_queue_no` <> 0
  AND NOT EXISTS (SELECT 1 FROM `appointment` a WHERE a.`schedule_id` = s.`id`);

-- ---------------------------------------------------------------------
-- 存量重复号清单（只读留档，本脚本不改号）
-- ---------------------------------------------------------------------
SELECT a.`schedule_id`, a.`queue_no`, COUNT(*) AS copies,
       GROUP_CONCAT(a.`id` ORDER BY a.`id`)       AS appt_ids,
       GROUP_CONCAT(a.`status` ORDER BY a.`id`)   AS statuses,
       MAX(a.`deleted`)                           AS any_deleted
FROM `appointment` a
WHERE a.`queue_no` IS NOT NULL
GROUP BY a.`schedule_id`, a.`queue_no`
HAVING COUNT(*) > 1
ORDER BY a.`schedule_id`, a.`queue_no`;

-- 回退（仅在确认没有新单依赖该列时执行）：
-- ALTER TABLE `doctor_schedule` DROP COLUMN `last_queue_no`;
