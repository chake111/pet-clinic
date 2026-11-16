-- 看板按就诊日期取数的索引。
--
-- 适用：**已有数据库升级**。新库由 sql/01_schema.sql 直接建出该索引
-- （建表语句里已有 `KEY idx_visit_date (appointment_date)`），不要再执行本脚本，
-- 否则会报 ERROR 1061 Duplicate key name。重复执行同样报 1061，属预期的防重跑信号，
-- 与 20260922_add_schedule_queue_counter.sql 的约定一致。
--
-- 背景：后台看板一次请求要读"今天"的单量与营收，趋势 / 状态分布 / 科室分布按
-- appointment_date 做 BETWEEN 聚合。原先 appointment 上只有 idx_status（只含 status 一列）
-- 和 idx_doctor_date（前导列是 doctor_id），全院口径（doctor_id 为 NULL 不过滤）的
-- 等值/范围条件 appointment_date 没有可用索引，EXPLAIN 是 type=ALL。
--
-- 执行前（隔离库，103 行数据）：
--   SELECT COUNT(*) ... WHERE deleted=0 AND appointment_date=CURDATE()
--     => type=ALL  key=NULL  rows=103
--   SELECT IFNULL(SUM(amount),0) ... pay_status=1 AND appointment_date=CURDATE()
--     => type=ALL  key=NULL  rows=103
--
-- 加索引后这两条应当变成 type=ref / range，key=idx_visit_date。
-- 医生视角继续用已有的 idx_doctor_date(doctor_id, appointment_date)，前导列就是等值条件。
--
-- 在线 DDL：MySQL 8 的 ADD INDEX 默认 ALGORITHM=INPLACE、LOCK=NONE，不阻塞读写。
-- 但开始与结束各需一次短暂的 MDL（元数据锁）：若有长事务未提交，ALTER 会排在它后面，
-- 并把之后的新请求一起挡住。所以**选低峰执行**，并显式写出两个子句——条件不满足时
-- 直接报错，而不是静默降级成 COPY（COPY 会全程锁表）。
--
-- 回退：DROP INDEX idx_visit_date ON appointment;
-- 影响：新增一个二级索引，写入时多维护一列；单店量级下可忽略。

ALTER TABLE `appointment`
  ADD INDEX `idx_visit_date` (`appointment_date`), ALGORITHM = INPLACE, LOCK = NONE;

-- 执行后核对（两条都必须命中 idx_visit_date）：
-- EXPLAIN SELECT COUNT(*) FROM appointment WHERE deleted=0 AND appointment_date=CURDATE();
-- EXPLAIN SELECT IFNULL(SUM(amount),0) FROM appointment
--   WHERE deleted=0 AND pay_status=1 AND appointment_date=CURDATE();
