-- =====================================================================
-- 20261001_drop_doctor_emp_no.sql
-- 删除 doctor.emp_no（院内工号）列。
--
-- 适用：已有数据库升级。新库请直接执行 01_schema.sql + 02_data.sql。
-- 注意：01_schema.sql 含 DROP TABLE 语句，禁止用于已有库升级。
--
-- 执行前先确认列仍存在（MySQL 8.0 不支持 DROP COLUMN IF EXISTS）：
--   SELECT COUNT(*) FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME = 'doctor' AND COLUMN_NAME = 'emp_no';
-- 结果为 1 时执行下面的删列语句；结果为 0 说明已删除，无需执行。
--
-- 回滚：删列不能通过事务回滚撤销，原工号只能依靠迁移前备份
-- （结构 + 全量数据 + id→emp_no 映射）按 id 回填恢复。
-- =====================================================================

ALTER TABLE `doctor` DROP COLUMN `emp_no`;
