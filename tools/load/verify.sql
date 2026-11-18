-- =====================================================================
--  k6 压测后的一致性校验
--  对 schedule 9001/9002 检查号源守恒、排队号唯一、计数器一致。
--
--  PASS 条件 (四个同时成立):
--    1) remain_num >= 0
--    2) booked + remain_num = total_num
--    3) distinct_queue = booked            (没有重复发放的排队号)
--    4) max_queue = last_queue_no          (空集合时 max_queue 记 0)
--  booked 只统计未取消 (status <> 3) 的订单; last_queue_no 取消不回退。
-- =====================================================================

USE `yuzhua`;
SET NAMES utf8mb4;

SELECT
    s.`id`                                    AS `schedule_id`,
    s.`total_num`                             AS `total_num`,
    s.`remain_num`                            AS `remain_num`,
    s.`last_queue_no`                         AS `last_queue_no`,
    COALESCE(a.`booked`, 0)                   AS `booked`,
    COALESCE(a.`distinct_queue`, 0)           AS `distinct_queue`,
    COALESCE(a.`min_queue`, 0)                AS `min_queue`,
    COALESCE(a.`max_queue`, 0)                AS `max_queue`,
    CASE
        WHEN s.`remain_num` >= 0
         AND COALESCE(a.`booked`, 0) + s.`remain_num` = s.`total_num`
         AND COALESCE(a.`distinct_queue`, 0) = COALESCE(a.`booked`, 0)
         AND COALESCE(a.`max_queue`, 0) = s.`last_queue_no`
        THEN 'PASS'
        ELSE 'FAIL'
    END                                       AS `verdict`
FROM `doctor_schedule` s
LEFT JOIN (
    SELECT
        `schedule_id`,
        COUNT(*)                  AS `booked`,
        COUNT(DISTINCT `queue_no`) AS `distinct_queue`,
        MIN(`queue_no`)           AS `min_queue`,
        MAX(`queue_no`)           AS `max_queue`
    FROM `appointment`
    WHERE `schedule_id` IN (9001, 9002)
      AND `status` <> 3
    GROUP BY `schedule_id`
) a ON a.`schedule_id` = s.`id`
WHERE s.`id` IN (9001, 9002)
ORDER BY s.`id`;