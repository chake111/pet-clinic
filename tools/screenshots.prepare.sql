-- =====================================================================
--  tools/screenshots.prepare.sql
--  截图演示状态准备（幂等，可重复执行）
--
--  前置：
--    1) 先导入 sql/01_schema.sql
--    2) 再导入 sql/02_data.sql
--    3) 最后执行本文件
--
--  用法：
--    mysql -h127.0.0.1 -P3307 -uroot yuzhua < tools/screenshots.prepare.sql
--
--  安全警告：
--    本文件含 `USE yuzhua`，只允许在 127.0.0.1:3307 的临时实例执行。
--    若在 3306 业务实例执行，会切到业务库并插入演示订单/排班，禁止。
--    执行前先确认端口是 3307；不确定就不要跑。
--
--  对应截图：
--    13-client-pay                 张三 · 布丁 · 陈明远 待支付到院单
--    31-doctor-workbench           刘恋今日已接诊门诊 + 已保存病历
--    41-admin-schedule-stopped-slot 林若初未来排班被 2 条预约引用后停诊
--    42-admin-schedule-adjust-frozen 同上，调整弹窗显示归属冻结
--
--  其余截图依赖 02_data.sql 的历史订单、问诊会话与档案数据。
--  本文件不包含账号、密码或密钥，只补充上述演示状态。
-- =====================================================================

USE `yuzhua`;
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. 13-client-pay：张三（user 1） / 布丁（pet 1） / 陈明远（doctor 1）
--    取明天及以后最早的可用号源，保证订单日期始终在未来。
-- ---------------------------------------------------------------------
SET @pay_sid = (
  SELECT s.id
  FROM `doctor_schedule` s
  WHERE s.doctor_id = 1
    AND s.work_date >= DATE_ADD(CURDATE(), INTERVAL 1 DAY)
    AND s.status = 1
  ORDER BY s.work_date, s.period
  LIMIT 1
);

INSERT INTO `appointment`
(`order_no`, `idem_key`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `schedule_id`,
 `consult_type`, `appointment_date`, `period`, `start_time`, `end_time`, `queue_no`,
 `symptom`, `amount`, `pay_status`, `pay_time`, `pay_type`, `status`, `accept_time`,
 `finish_time`, `cancel_reason`, `cancel_time`, `cancel_by`, `is_reviewed`, `create_time`, `deleted`)
SELECT 'SHOT-PENDING-13', 'shot-pending-13', 1, 1, 1, 1, s.id,
       2, s.work_date, s.period, s.start_time, s.end_time, 3,
       '近两天饭后偶有干呕，精神尚可，预约到院复查。', 80.00,
       0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 0, NOW(), 0
FROM `doctor_schedule` s
WHERE s.id = @pay_sid
ON DUPLICATE KEY UPDATE
  `idem_key` = VALUES(`idem_key`),
  `user_id` = VALUES(`user_id`),
  `pet_id` = VALUES(`pet_id`),
  `doctor_id` = VALUES(`doctor_id`),
  `department_id` = VALUES(`department_id`),
  `schedule_id` = VALUES(`schedule_id`),
  `consult_type` = VALUES(`consult_type`),
  `appointment_date` = VALUES(`appointment_date`),
  `period` = VALUES(`period`),
  `start_time` = VALUES(`start_time`),
  `end_time` = VALUES(`end_time`),
  `queue_no` = VALUES(`queue_no`),
  `symptom` = VALUES(`symptom`),
  `amount` = VALUES(`amount`),
  `pay_status` = 0,
  `pay_time` = NULL,
  `pay_type` = NULL,
  `status` = 0,
  `accept_time` = NULL,
  `finish_time` = NULL,
  `cancel_reason` = NULL,
  `cancel_time` = NULL,
  `cancel_by` = NULL,
  `is_reviewed` = 0,
  `create_time` = NOW(),
  `deleted` = 0;

-- ---------------------------------------------------------------------
-- 2. 31-doctor-workbench：刘恋（doctor 11）今日上午已接诊 + 已保存病历
--    种子未给今天排班时补一条，保证医生端“今日预约”能看到该单。
-- ---------------------------------------------------------------------
INSERT INTO `doctor_schedule`
(`doctor_id`, `work_date`, `period`, `start_time`, `end_time`, `total_num`, `remain_num`, `status`)
SELECT 11, CURDATE(), 1, '08:30:00', '12:00:00', 20, 20, 1
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `doctor_schedule`
  WHERE `doctor_id` = 11 AND `work_date` = CURDATE() AND `period` = 1
);

SET @wb_sid = (
  SELECT s.id
  FROM `doctor_schedule` s
  WHERE s.doctor_id = 11 AND s.work_date = CURDATE()
  ORDER BY (s.status = 1) DESC, s.period
  LIMIT 1
);

INSERT INTO `appointment`
(`order_no`, `idem_key`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `schedule_id`,
 `consult_type`, `appointment_date`, `period`, `start_time`, `end_time`, `queue_no`,
 `symptom`, `amount`, `pay_status`, `pay_time`, `pay_type`, `status`, `accept_time`,
 `finish_time`, `cancel_reason`, `cancel_time`, `cancel_by`, `is_reviewed`, `create_time`, `deleted`)
SELECT 'SHOT-WORKBENCH-31', 'shot-workbench-31', 1, 1, 11, 10, s.id,
       2, s.work_date, s.period, s.start_time, s.end_time, 2,
       '饭后偶有干呕两天，食欲略有下降。', 70.00,
       1, NOW(), 'MOCK', 1, NOW(), NULL, NULL, NULL, NULL, 0, NOW(), 0
FROM `doctor_schedule` s
WHERE s.id = @wb_sid
ON DUPLICATE KEY UPDATE
  `idem_key` = VALUES(`idem_key`),
  `user_id` = VALUES(`user_id`),
  `pet_id` = VALUES(`pet_id`),
  `doctor_id` = VALUES(`doctor_id`),
  `department_id` = VALUES(`department_id`),
  `schedule_id` = VALUES(`schedule_id`),
  `consult_type` = VALUES(`consult_type`),
  `appointment_date` = VALUES(`appointment_date`),
  `period` = VALUES(`period`),
  `start_time` = VALUES(`start_time`),
  `end_time` = VALUES(`end_time`),
  `queue_no` = VALUES(`queue_no`),
  `symptom` = VALUES(`symptom`),
  `amount` = VALUES(`amount`),
  `pay_status` = 1,
  `pay_time` = NOW(),
  `pay_type` = 'MOCK',
  `status` = 1,
  `accept_time` = NOW(),
  `finish_time` = NULL,
  `cancel_reason` = NULL,
  `cancel_time` = NULL,
  `cancel_by` = NULL,
  `is_reviewed` = 0,
  `create_time` = NOW(),
  `deleted` = 0;

SET @wb_id = (SELECT `id` FROM `appointment` WHERE `order_no` = 'SHOT-WORKBENCH-31' LIMIT 1);

INSERT INTO `medical_record`
(`record_no`, `appointment_id`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `visit_date`,
 `chief_complaint`, `physical_exam`, `diagnosis`, `prescription`, `treatment`, `advice`,
 `next_visit_date`, `create_time`, `deleted`)
SELECT 'SHOT-MR-31', @wb_id, 1, 1, 11, 10, CURDATE(),
       '饭后偶有干呕两天，食欲略有下降。',
       '精神尚可，体温正常，腹部触诊无明显疼痛。',
       '胃肠道不适，需结合到院检查结果观察。',
       '按到院医嘱用药，避免自行增加剂量。',
       '完成体格检查，评估饮食和近期换粮情况。',
       '少量多餐，记录进食与呕吐情况；症状加重时及时复诊。',
       DATE_ADD(CURDATE(), INTERVAL 3 DAY), NOW(), 0
FROM DUAL
WHERE @wb_id IS NOT NULL
ON DUPLICATE KEY UPDATE
  `appointment_id` = VALUES(`appointment_id`),
  `user_id` = VALUES(`user_id`),
  `pet_id` = VALUES(`pet_id`),
  `doctor_id` = VALUES(`doctor_id`),
  `department_id` = VALUES(`department_id`),
  `visit_date` = VALUES(`visit_date`),
  `chief_complaint` = VALUES(`chief_complaint`),
  `physical_exam` = VALUES(`physical_exam`),
  `diagnosis` = VALUES(`diagnosis`),
  `prescription` = VALUES(`prescription`),
  `treatment` = VALUES(`treatment`),
  `advice` = VALUES(`advice`),
  `next_visit_date` = VALUES(`next_visit_date`),
  `create_time` = NOW(),
  `deleted` = 0;

-- ---------------------------------------------------------------------
-- 3. 41/42：林若初（doctor 2）未来排班被 2 条预约引用后停诊
--    优先复用已有的 SHOT-STOP-41A 排班；若它已过期，再选未来 0 引用的排班。
-- ---------------------------------------------------------------------
SET @stop_sid = (
  SELECT a.schedule_id
  FROM `appointment` a
  JOIN `doctor_schedule` s ON s.id = a.schedule_id
  WHERE a.order_no = 'SHOT-STOP-41A'
    AND s.work_date >= CURDATE()
  LIMIT 1
);

SET @stop_sid = IFNULL(@stop_sid, (
  SELECT s.id
  FROM `doctor_schedule` s
  WHERE s.doctor_id = 2
    AND s.work_date >= CURDATE()
    AND s.status = 1
    AND NOT EXISTS (SELECT 1 FROM `appointment` a WHERE a.schedule_id = s.id)
  ORDER BY s.work_date DESC, s.period
  LIMIT 1
));

-- 林若初没有可用排班时，退回到任意未来且未被引用的排班，避免脚本空跑。
SET @stop_sid = IFNULL(@stop_sid, (
  SELECT s.id
  FROM `doctor_schedule` s
  WHERE s.work_date >= CURDATE()
    AND s.status = 1
    AND NOT (s.id <=> @pay_sid)
    AND NOT EXISTS (SELECT 1 FROM `appointment` a WHERE a.schedule_id = s.id)
  ORDER BY s.work_date DESC, s.period
  LIMIT 1
));

INSERT INTO `appointment`
(`order_no`, `idem_key`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `schedule_id`,
 `consult_type`, `appointment_date`, `period`, `start_time`, `end_time`, `queue_no`,
 `symptom`, `amount`, `pay_status`, `pay_time`, `pay_type`, `status`, `accept_time`,
 `finish_time`, `cancel_reason`, `cancel_time`, `cancel_by`, `is_reviewed`, `create_time`, `deleted`)
SELECT 'SHOT-STOP-41A', 'shot-stop-41a', 2, 3, s.doctor_id, d.department_id, s.id,
       2, s.work_date, s.period, s.start_time, s.end_time, 1,
       '掉毛增多，背部有小块圆形脱毛，想复查皮肤。', d.consultation_fee,
       1, NOW(), 'ALIPAY', 0, NULL, NULL, NULL, NULL, NULL, 0, NOW(), 0
FROM `doctor_schedule` s
JOIN `doctor` d ON d.id = s.doctor_id
WHERE s.id = @stop_sid
ON DUPLICATE KEY UPDATE
  `idem_key` = VALUES(`idem_key`),
  `user_id` = VALUES(`user_id`),
  `pet_id` = VALUES(`pet_id`),
  `doctor_id` = VALUES(`doctor_id`),
  `department_id` = VALUES(`department_id`),
  `schedule_id` = VALUES(`schedule_id`),
  `consult_type` = VALUES(`consult_type`),
  `appointment_date` = VALUES(`appointment_date`),
  `period` = VALUES(`period`),
  `start_time` = VALUES(`start_time`),
  `end_time` = VALUES(`end_time`),
  `queue_no` = VALUES(`queue_no`),
  `symptom` = VALUES(`symptom`),
  `amount` = VALUES(`amount`),
  `pay_status` = 1,
  `pay_time` = NOW(),
  `pay_type` = 'ALIPAY',
  `status` = 0,
  `accept_time` = NULL,
  `finish_time` = NULL,
  `cancel_reason` = NULL,
  `cancel_time` = NULL,
  `cancel_by` = NULL,
  `is_reviewed` = 0,
  `create_time` = NOW(),
  `deleted` = 0;

INSERT INTO `appointment`
(`order_no`, `idem_key`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `schedule_id`,
 `consult_type`, `appointment_date`, `period`, `start_time`, `end_time`, `queue_no`,
 `symptom`, `amount`, `pay_status`, `pay_time`, `pay_type`, `status`, `accept_time`,
 `finish_time`, `cancel_reason`, `cancel_time`, `cancel_by`, `is_reviewed`, `create_time`, `deleted`)
SELECT 'SHOT-STOP-41B', 'shot-stop-41b', 3, 5, s.doctor_id, d.department_id, s.id,
       2, s.work_date, s.period, s.start_time, s.end_time, 2,
       '年度体检，顺便复查髋关节。', d.consultation_fee,
       1, NOW(), 'WECHAT', 1, NOW(), NULL, NULL, NULL, NULL, 0, NOW(), 0
FROM `doctor_schedule` s
JOIN `doctor` d ON d.id = s.doctor_id
WHERE s.id = @stop_sid
ON DUPLICATE KEY UPDATE
  `idem_key` = VALUES(`idem_key`),
  `user_id` = VALUES(`user_id`),
  `pet_id` = VALUES(`pet_id`),
  `doctor_id` = VALUES(`doctor_id`),
  `department_id` = VALUES(`department_id`),
  `schedule_id` = VALUES(`schedule_id`),
  `consult_type` = VALUES(`consult_type`),
  `appointment_date` = VALUES(`appointment_date`),
  `period` = VALUES(`period`),
  `start_time` = VALUES(`start_time`),
  `end_time` = VALUES(`end_time`),
  `queue_no` = VALUES(`queue_no`),
  `symptom` = VALUES(`symptom`),
  `amount` = VALUES(`amount`),
  `pay_status` = 1,
  `pay_time` = NOW(),
  `pay_type` = 'WECHAT',
  `status` = 1,
  `accept_time` = NOW(),
  `finish_time` = NULL,
  `cancel_reason` = NULL,
  `cancel_time` = NULL,
  `cancel_by` = NULL,
  `is_reviewed` = 0,
  `create_time` = NOW(),
  `deleted` = 0;

UPDATE `doctor_schedule` s
SET s.status = 0,
    s.remain_num = GREATEST(0, s.total_num - (
      SELECT COUNT(*) FROM `appointment` a
      WHERE a.schedule_id = s.id AND a.deleted = 0
    ))
WHERE s.id = @stop_sid;

-- ---------------------------------------------------------------------
-- 4. 人工核对输出（幂等执行后应保持：1 个待支付单、1 个工作台单、
--    1 份病历、2 个停诊引用单、停诊排班引用数 2）
-- ---------------------------------------------------------------------
SELECT '13 pending' AS state, `order_no`, `status`, `pay_status`, `appointment_date`
FROM `appointment` WHERE `order_no` = 'SHOT-PENDING-13';
SELECT '31 workbench' AS state, `order_no`, `status`, `pay_status`, `appointment_date`
FROM `appointment` WHERE `order_no` = 'SHOT-WORKBENCH-31';
SELECT '31 record' AS state, `record_no`, `appointment_id`, `diagnosis`
FROM `medical_record` WHERE `record_no` = 'SHOT-MR-31';
SELECT '41/42 stop orders' AS state, COUNT(*) AS `count`
FROM `appointment` WHERE `order_no` IN ('SHOT-STOP-41A', 'SHOT-STOP-41B');
SELECT '41/42 stop schedule' AS state, s.id, s.doctor_id, s.work_date, s.status, s.remain_num,
       (SELECT COUNT(*) FROM `appointment` a WHERE a.schedule_id = s.id AND a.deleted = 0) AS ref_num
FROM `doctor_schedule` s WHERE s.id = @stop_sid;
