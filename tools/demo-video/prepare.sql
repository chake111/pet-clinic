-- =====================================================================
--  tools/demo-video/prepare.sql
--  演示视频可重复数据准备脚本（幂等，可连续重复执行）
--
--  前置：
--    1) 本地 Docker Compose 栈（compose.yaml）已启动且 db 健康
--    2) 库内已导入 sql/01_schema.sql 与 sql/02_data.sql（含 13 号医生苏晚晴与 11 号宠物团团）
--
--  用法（PowerShell / Bash，通过容器内环境变量免明文口令）：
--    Get-Content -Raw -Encoding UTF8 tools/demo-video/prepare.sql |
--      docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u petapp --default-character-set=utf8mb4 yuzhua'
--
--  安全警告：
--    仅允许在本地演示 Compose 容器库执行，禁止在生产库运行。
--    本脚本不改密码、不改历史非演示单，仅：
--      1) 确认演示角色（张三/团团/苏晚晴/管理员）启用；
--      2) 清理张三与苏晚晴的残留问诊会话、当日及未来预约（含关联病历/评价）；
--      3) 确保苏晚晴今天及未来 6 天三班（上午/下午/夜间）排班存在且正常出诊；
--      4) 幂等重建近 14 天多科室/多医生演示历史单（order_no LIKE 'DEMO-HIST-%'，
--         不含张三、当日不含苏晚晴），使管理端看板（默认近 14 天）图表饱满真实；
--      5) 按 02_data.sql 同口径回填 remain_num、last_queue_no 与 doctor.appointment_count，
--         保证号源守恒与排队号递增不变量。
-- =====================================================================

USE `yuzhua`;
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. 确认演示角色账号与档案处于正常状态
-- ---------------------------------------------------------------------
UPDATE `sys_user`
SET `status` = 1, `deleted` = 0
WHERE `id` = 1 AND `username` = 'zhangsan';

UPDATE `pet`
SET `deleted` = 0
WHERE `id` = 11 AND `user_id` = 1;

UPDATE `doctor`
SET `status` = 1, `deleted` = 0
WHERE `id` = 13;

UPDATE `admin_user`
SET `status` = 1, `deleted` = 0
WHERE `username` IN ('admin', 'doctor13');

-- ---------------------------------------------------------------------
-- 2. 清理张三（user 1）与苏晚晴（doctor 13）之间的全部演示问诊会话
--    确保录制开始时双方无进行中或残留会话
-- ---------------------------------------------------------------------
DELETE cm
FROM `consult_message` cm
JOIN `consult_session` cs ON cs.id = cm.session_id
WHERE cs.user_id = 1 AND cs.doctor_id = 13;

DELETE FROM `consult_session`
WHERE `user_id` = 1 AND `doctor_id` = 13;

-- ---------------------------------------------------------------------
-- 3. 清理两类可再生记录：
--    A) 张三在苏晚晴名下的当日及未来预约（上次录屏产生的实单）
--    B) 本脚本维护的近 14 天看板演示单（order_no LIKE 'DEMO-HIST-%'）
-- ---------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_del_appt`;
CREATE TEMPORARY TABLE `tmp_demo_del_appt` (`id` BIGINT PRIMARY KEY);

INSERT INTO `tmp_demo_del_appt` (`id`)
SELECT a.id
FROM `appointment` a
WHERE (a.user_id = 1 AND a.doctor_id = 13 AND a.appointment_date >= CURDATE())
   OR a.order_no LIKE 'DEMO-HIST-%';

DELETE r
FROM `doctor_review` r
JOIN `tmp_demo_del_appt` d ON d.id = r.appointment_id;

DELETE m
FROM `medical_record` m
JOIN `tmp_demo_del_appt` d ON d.id = m.appointment_id;

DELETE a
FROM `appointment` a
JOIN `tmp_demo_del_appt` d ON d.id = a.id;

DROP TEMPORARY TABLE IF EXISTS `tmp_demo_del_appt`;

-- ---------------------------------------------------------------------
-- 4. 确保苏晚晴（doctor 13）今天及未来 6 天全天三班可约（status=1）
--    另防御性确保近 13 天每天至少有一批正常排班（应对过期卷）
-- ---------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_offset`;
CREATE TEMPORARY TABLE `tmp_demo_offset` (`off` INT PRIMARY KEY);
INSERT INTO `tmp_demo_offset` VALUES
(-13),(-12),(-11),(-10),(-9),(-8),(-7),(-6),(-5),(-4),(-3),(-2),(-1),
(0),(1),(2),(3),(4),(5),(6);

DROP TEMPORARY TABLE IF EXISTS `tmp_demo_period`;
CREATE TEMPORARY TABLE `tmp_demo_period` (`p` TINYINT PRIMARY KEY, `s` TIME, `e` TIME, `num` INT);
INSERT INTO `tmp_demo_period` VALUES
(1, '08:30:00', '12:00:00', 20),
(2, '13:30:00', '17:30:00', 20),
(3, '18:00:00', '21:30:00', 12);

-- 苏晚晴今天及未来 6 天三班保底存在
INSERT IGNORE INTO `doctor_schedule`
(`doctor_id`, `work_date`, `period`, `start_time`, `end_time`, `total_num`, `remain_num`, `last_queue_no`, `status`)
SELECT 13, DATE_ADD(CURDATE(), INTERVAL o.off DAY), p.p, p.s, p.e, p.num, p.num, 0, 1
FROM `tmp_demo_offset` o
JOIN `tmp_demo_period` p
WHERE o.off BETWEEN 0 AND 6;

-- 若苏晚晴今天三班被停诊，恢复正常出诊
UPDATE `doctor_schedule`
SET `status` = 1
WHERE `doctor_id` = 13
  AND `work_date` BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 6 DAY);

-- 若数据库卷较老导致近 14 天某些天没有其他医生排班，则只对空日期补最小排班
DROP TEMPORARY TABLE IF EXISTS `tmp_missing_days`;
CREATE TEMPORARY TABLE `tmp_missing_days` (`d` DATE PRIMARY KEY);
INSERT INTO `tmp_missing_days` (`d`)
SELECT DATE_ADD(CURDATE(), INTERVAL o.off DAY)
FROM `tmp_demo_offset` o
WHERE o.off BETWEEN -13 AND 0
  AND NOT EXISTS (
    SELECT 1 FROM `doctor_schedule` s
    WHERE s.work_date = DATE_ADD(CURDATE(), INTERVAL o.off DAY)
      AND s.doctor_id <> 13
      AND s.status = 1
  );

INSERT IGNORE INTO `doctor_schedule`
(`doctor_id`, `work_date`, `period`, `start_time`, `end_time`, `total_num`, `remain_num`, `last_queue_no`, `status`)
SELECT d.id, md.d, 1, '08:30:00', '12:00:00', 20, 20, 0, 1
FROM `tmp_missing_days` md
JOIN `doctor` d ON d.status = 1 AND d.deleted = 0 AND d.id IN (1, 2, 3, 5, 6, 7, 11, 13);

DROP TEMPORARY TABLE IF EXISTS `tmp_missing_days`;
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_offset`;
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_period`;

-- ---------------------------------------------------------------------
-- 5. 幂等生成近 14 天多科室/多医生演示历史单（DEMO-HIST-01 .. 48）
--    设计约定：
--      - 仅使用非张三宠主（user 2..5，pet 3..10），不污染张三的预约列表
--      - 过去 13 天（-13..-1）覆盖全部在诊科室与多位医生（含苏晚晴）
--      - 当天（CURDATE()）仅生成 4 单其他医生预约（doctor_id <> 13），
--        保证医生端苏晚晴今日接诊清单干净聚焦团团，且管理端今日概览饱满
--      - 不生成未支付待接诊单，避免与定时超时清扫任务产生竞态
-- ---------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_userpet`;
CREATE TEMPORARY TABLE `tmp_demo_userpet` (
  `rn` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `pet_id` BIGINT NOT NULL
);
INSERT INTO `tmp_demo_userpet` (`user_id`, `pet_id`)
SELECT p.user_id, p.id
FROM `pet` p
JOIN `sys_user` u ON u.id = p.user_id AND u.deleted = 0 AND u.status = 1
WHERE p.deleted = 0 AND p.user_id <> 1
ORDER BY p.user_id, p.id;

SET @demo_upc = (SELECT COUNT(*) FROM `tmp_demo_userpet`);

DROP TEMPORARY TABLE IF EXISTS `tmp_demo_candidates`;
CREATE TEMPORARY TABLE `tmp_demo_candidates` (
  `seq` INT PRIMARY KEY AUTO_INCREMENT,
  `schedule_id` BIGINT NOT NULL,
  `doctor_id` BIGINT NOT NULL,
  `department_id` BIGINT NOT NULL,
  `work_date` DATE NOT NULL,
  `period` TINYINT NOT NULL,
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL,
  `fee` DECIMAL(10,2) NOT NULL,
  `is_today` TINYINT NOT NULL
);

-- 5.1 过去 13 天：每天挑 3–5 个不同医生的有效排班（共约 44 单），曲线自然起伏
INSERT INTO `tmp_demo_candidates`
(`schedule_id`, `doctor_id`, `department_id`, `work_date`, `period`, `start_time`, `end_time`, `fee`, `is_today`)
SELECT ranked.schedule_id, ranked.doctor_id, ranked.department_id,
       ranked.work_date, ranked.period, ranked.start_time, ranked.end_time, ranked.fee, 0
FROM (
  SELECT s.id AS schedule_id, s.doctor_id, d.department_id,
         s.work_date, s.period, s.start_time, s.end_time, d.consultation_fee AS fee,
         ROW_NUMBER() OVER (
           PARTITION BY s.work_date
           ORDER BY ((s.doctor_id * 7 + DATEDIFF(CURDATE(), s.work_date) * 5) % 13), s.period, s.id
         ) AS day_rn,
         (CASE (DATEDIFF(CURDATE(), s.work_date) % 5)
            WHEN 0 THEN 5
            WHEN 1 THEN 4
            WHEN 2 THEN 3
            WHEN 3 THEN 4
            ELSE 2
          END) AS day_quota
  FROM `doctor_schedule` s
  JOIN `doctor` d ON d.id = s.doctor_id AND d.status = 1 AND d.deleted = 0
  WHERE s.status = 1
    AND s.work_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    -- 每天每位医生至多取最早一个班次，让科室和医生分布均匀
    AND s.period = (
      SELECT MIN(s2.period)
      FROM `doctor_schedule` s2
      WHERE s2.doctor_id = s.doctor_id AND s2.work_date = s.work_date AND s2.status = 1
    )
) ranked
WHERE ranked.day_rn <= ranked.day_quota
ORDER BY ranked.work_date, ranked.day_rn;

-- 5.2 当天（CURDATE()）：取 4 个非苏晚晴医生的有效排班（2 已完成、1 就诊中、1 已付待接诊）
INSERT INTO `tmp_demo_candidates`
(`schedule_id`, `doctor_id`, `department_id`, `work_date`, `period`, `start_time`, `end_time`, `fee`, `is_today`)
SELECT s.id, s.doctor_id, d.department_id,
       s.work_date, s.period, s.start_time, s.end_time, d.consultation_fee, 1
FROM `doctor_schedule` s
JOIN `doctor` d ON d.id = s.doctor_id AND d.status = 1 AND d.deleted = 0
WHERE s.status = 1
  AND s.work_date = CURDATE()
  AND s.doctor_id <> 13
  AND s.period = (
    SELECT MIN(s2.period)
    FROM `doctor_schedule` s2
    WHERE s2.doctor_id = s.doctor_id AND s2.work_date = s.work_date AND s2.status = 1
  )
ORDER BY s.doctor_id
LIMIT 4;

-- 记录各排班在插入 DEMO-HIST 前已占用的最大排队号（绝不改写历史非演示单序号）
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_base_qno`;
CREATE TEMPORARY TABLE `tmp_demo_base_qno` (
  `schedule_id` BIGINT PRIMARY KEY,
  `max_no` INT NOT NULL
);
INSERT INTO `tmp_demo_base_qno` (`schedule_id`, `max_no`)
SELECT `schedule_id`, IFNULL(MAX(`queue_no`), 0)
FROM `appointment`
WHERE `schedule_id` IS NOT NULL AND `queue_no` IS NOT NULL
GROUP BY `schedule_id`;

SET @today_min_seq = (SELECT MIN(`seq`) FROM `tmp_demo_candidates` WHERE `is_today` = 1);

INSERT INTO `appointment`
(`order_no`, `idem_key`, `user_id`, `pet_id`, `doctor_id`, `department_id`, `schedule_id`,
 `consult_type`, `appointment_date`, `period`, `start_time`, `end_time`, `queue_no`,
 `symptom`, `amount`, `pay_status`, `pay_time`, `pay_type`, `status`, `accept_time`,
 `finish_time`, `cancel_reason`, `cancel_time`, `cancel_by`, `is_reviewed`, `create_time`, `deleted`)
SELECT
  CONCAT('DEMO-HIST-', LPAD(c.seq, 2, '0')),
  NULL,
  up.user_id,
  up.pet_id,
  c.doctor_id,
  c.department_id,
  c.schedule_id,
  2,
  c.work_date,
  c.period,
  c.start_time,
  c.end_time,
  -- 每张排班至多插入 1 条 DEMO-HIST 单；取消单（past 且 seq%13=0）不发号
  CASE
    WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN NULL
    ELSE IFNULL(bq.max_no, 0) + 1
  END,
  ELT(1 + (c.seq % 6),
      '精神略差、食欲下降两天，到院做基础血常规与体格检查。',
      '耳道轻微瘙痒并伴少量皮屑，到院复查皮肤与耳道情况。',
      '按计划到院接种年度加强疫苗并进行体内外驱虫评估。',
      '牙龈轻度红肿伴口臭，预约口腔检查与洁治评估。',
      '后肢偶有跛行，到院做关节触诊与影像复查。',
      '定期体检复查腹部超声与生化指标。'),
  c.fee,
  CASE
    WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN 0
    ELSE 1
  END,
  CASE
    WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN NULL
    ELSE CONCAT(c.work_date, ' 08:15:00')
  END,
  CASE
    WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN NULL
    ELSE ELT(1 + (c.seq % 3), 'WECHAT', 'ALIPAY', 'MOCK')
  END,
  CASE
    WHEN c.is_today = 1 THEN
      CASE (c.seq - @today_min_seq)
        WHEN 0 THEN 2
        WHEN 1 THEN 2
        WHEN 2 THEN 1
        ELSE 0
      END
    WHEN (c.seq % 13) = 0 THEN 3
    WHEN (c.seq % 17) = 0 THEN 4
    ELSE 2
  END,
  CASE
    WHEN c.is_today = 1 AND (c.seq - @today_min_seq) >= 3 THEN NULL
    WHEN c.is_today = 0 AND ((c.seq % 13) = 0 OR (c.seq % 17) = 0) THEN NULL
    ELSE CONCAT(c.work_date, ' 09:05:00')
  END,
  CASE
    WHEN c.is_today = 1 AND (c.seq - @today_min_seq) >= 2 THEN NULL
    WHEN c.is_today = 0 AND ((c.seq % 13) = 0 OR (c.seq % 17) = 0) THEN NULL
    ELSE CONCAT(c.work_date, ' 09:40:00')
  END,
  CASE WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN '行程调整，改约下周' ELSE NULL END,
  CASE WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN CONCAT(c.work_date, ' 08:25:00') ELSE NULL END,
  CASE WHEN c.is_today = 0 AND (c.seq % 13) = 0 THEN 'USER' ELSE NULL END,
  0,
  CONCAT(DATE_SUB(c.work_date, INTERVAL 1 DAY), ' 20:10:00'),
  0
FROM `tmp_demo_candidates` c
JOIN `tmp_demo_userpet` up ON up.rn = 1 + ((c.seq * 3) % @demo_upc)
LEFT JOIN `tmp_demo_base_qno` bq ON bq.schedule_id = c.schedule_id;

DROP TEMPORARY TABLE IF EXISTS `tmp_demo_base_qno`;
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_candidates`;
DROP TEMPORARY TABLE IF EXISTS `tmp_demo_userpet`;

-- ---------------------------------------------------------------------
-- 6. 一致性回填（与 sql/02_data.sql 第 12 节完全同口径）
--    保证 remain_num 守恒、last_queue_no 对齐、医生接诊计数一致
-- ---------------------------------------------------------------------
UPDATE `doctor_schedule` s
SET s.remain_num = GREATEST(0, s.total_num - (
  SELECT COUNT(*)
  FROM `appointment` a
  WHERE a.schedule_id = s.id AND a.deleted = 0 AND a.status <> 3
));

UPDATE `doctor_schedule` s
LEFT JOIN (
  SELECT `schedule_id`, MAX(`queue_no`) AS max_no
  FROM `appointment`
  WHERE `queue_no` IS NOT NULL
  GROUP BY `schedule_id`
) h ON h.schedule_id = s.id
SET s.last_queue_no = IFNULL(h.max_no, 0);

UPDATE `doctor` d
SET d.appointment_count = (
  SELECT COUNT(*)
  FROM `appointment` a
  WHERE a.doctor_id = d.id AND a.deleted = 0 AND a.status = 2
);

-- ---------------------------------------------------------------------
-- 7. 自检输出（连跑两次本脚本以下结果应完全一致）
-- ---------------------------------------------------------------------
SELECT 'actors' AS check_item,
       (SELECT COUNT(*) FROM `sys_user` WHERE `id` = 1 AND `username` = 'zhangsan' AND `status` = 1 AND `deleted` = 0) AS owner_ok,
       (SELECT COUNT(*) FROM `pet` WHERE `id` = 11 AND `user_id` = 1 AND `deleted` = 0) AS pet_ok,
       (SELECT COUNT(*) FROM `doctor` WHERE `id` = 13 AND `status` = 1 AND `deleted` = 0) AS doc13_ok,
       (SELECT COUNT(*) FROM `admin_user` WHERE `username` IN ('admin', 'doctor13') AND `status` = 1 AND `deleted` = 0) AS staff_ok;

SELECT 'clean_slate' AS check_item,
       (SELECT COUNT(*) FROM `consult_session` WHERE `user_id` = 1 AND `doctor_id` = 13) AS doc13_sessions,
       (SELECT COUNT(*) FROM `appointment` WHERE `user_id` = 1 AND `doctor_id` = 13 AND `appointment_date` >= CURDATE() AND `deleted` = 0) AS doc13_today_future_appts,
       (SELECT COUNT(*) FROM `appointment` WHERE `doctor_id` = 13 AND `appointment_date` = CURDATE() AND `deleted` = 0) AS doc13_today_all_appts;

SELECT 'doc13_today_slots' AS check_item,
       `period`, `start_time`, `end_time`, `total_num`, `remain_num`, `last_queue_no`, `status`
FROM `doctor_schedule`
WHERE `doctor_id` = 13 AND `work_date` = CURDATE()
ORDER BY `period`;

SELECT 'invariants' AS check_item,
       (SELECT COUNT(*) FROM `doctor_schedule` s
        WHERE s.remain_num <> s.total_num - (SELECT COUNT(*) FROM `appointment` a WHERE a.schedule_id = s.id AND a.deleted = 0 AND a.status <> 3)) AS remain_mismatch,
       (SELECT COUNT(*) FROM `doctor_schedule` WHERE `remain_num` < 0 OR `remain_num` > `total_num`) AS remain_oob,
       (SELECT COUNT(*) FROM `doctor_schedule` s
        WHERE s.last_queue_no < IFNULL((SELECT MAX(a.queue_no) FROM `appointment` a WHERE a.schedule_id = s.id), 0)) AS qno_lag;

SELECT 'dashboard_14d' AS check_item,
       (SELECT COUNT(*) FROM `appointment` WHERE `order_no` LIKE 'DEMO-HIST-%' AND `deleted` = 0) AS demo_hist_rows,
       (SELECT COUNT(DISTINCT `appointment_date`) FROM `appointment` WHERE `deleted` = 0 AND `appointment_date` BETWEEN DATE_SUB(CURDATE(), INTERVAL 14 DAY) AND CURDATE()) AS trend_days,
       (SELECT COUNT(DISTINCT `department_id`) FROM `appointment` WHERE `deleted` = 0 AND `status` <> 3 AND `appointment_date` BETWEEN DATE_SUB(CURDATE(), INTERVAL 14 DAY) AND CURDATE()) AS dept_bars,
       (SELECT COUNT(DISTINCT `doctor_id`) FROM `appointment` WHERE `deleted` = 0 AND `status` = 2 AND `appointment_date` BETWEEN DATE_SUB(CURDATE(), INTERVAL 14 DAY) AND CURDATE()) AS ranked_doctors,
       (SELECT COUNT(*) FROM `appointment` WHERE `deleted` = 0 AND `appointment_date` = CURDATE()) AS today_orders;
