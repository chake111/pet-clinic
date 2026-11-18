-- =====================================================================
-- 20261118 数据库重命名：pet_clinic → yuzhua
--
-- 前置条件:
--   1) 旧库 `pet_clinic` 存在，且 13 张业务表都在旧库中（清单见下方 RENAME）。
--   2) 执行账号要有 CREATE DATABASE 与 RENAME/ALTER 权限（通常是 DBA 或 root）。
--   3) 先停应用写入（停后端或切只读），RENAME 期间不要有新连接写入。
--   4) 先做全量备份，例如:
--        mysqldump --single-transaction --routines --triggers pet_clinic > backup.sql
--
-- 执行方式:
--   mysql -u root -p --default-character-set=utf8mb4 < 20261118_rename_database_to_yuzhua.sql
--
-- 防重与幂等:
--   - CREATE DATABASE `yuzhua` 刻意不带 IF NOT EXISTS：目标库已存在时该语句自然失败，
--     脚本在 RENAME 之前停止，不会出现"库建了、表没迁"的半迁移状态。
--   - 重复执行会在 CREATE DATABASE 处报错退出，不会覆盖或删除已迁移的数据。
--   - 全部 13 张表放在一条 RENAME TABLE 里，同一实例内的元数据切换是原子的。
--
-- 回滚方式:
--   停应用写入后执行文件末尾的反向 RENAME 块（默认是注释，取消注释后执行）。
--   本脚本不 DROP 旧库 `pet_clinic`：迁移后旧库仍然存在，只是表已迁走。
--
-- 应用账号:
--   迁移不会自动授权。旧账号若只授权到 `pet_clinic`.*，迁移后需要由 DBA 补授权，
--   见文件末尾的 GRANT 注释。全新部署由 compose 的 MYSQL_DATABASE 自动建库授权。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 建新库：已存在则自然失败，作为防重护栏（脚本在此停止，不会半迁移）
--    字符集/排序规则与 sql/01_schema.sql 一致
-- ---------------------------------------------------------------------
CREATE DATABASE `yuzhua` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------
-- 1. 迁移前快照：执行本脚本时一并输出，迁移后与第 3 节逐表比对行数
-- ---------------------------------------------------------------------
SELECT 'before.sys_user'         AS table_name, COUNT(*) AS row_count FROM `pet_clinic`.`sys_user`
UNION ALL SELECT 'before.pet',               COUNT(*) FROM `pet_clinic`.`pet`
UNION ALL SELECT 'before.department',        COUNT(*) FROM `pet_clinic`.`department`
UNION ALL SELECT 'before.doctor',            COUNT(*) FROM `pet_clinic`.`doctor`
UNION ALL SELECT 'before.admin_user',        COUNT(*) FROM `pet_clinic`.`admin_user`
UNION ALL SELECT 'before.doctor_schedule',   COUNT(*) FROM `pet_clinic`.`doctor_schedule`
UNION ALL SELECT 'before.appointment',       COUNT(*) FROM `pet_clinic`.`appointment`
UNION ALL SELECT 'before.consult_session',   COUNT(*) FROM `pet_clinic`.`consult_session`
UNION ALL SELECT 'before.consult_message',   COUNT(*) FROM `pet_clinic`.`consult_message`
UNION ALL SELECT 'before.medical_record',    COUNT(*) FROM `pet_clinic`.`medical_record`
UNION ALL SELECT 'before.doctor_review',     COUNT(*) FROM `pet_clinic`.`doctor_review`
UNION ALL SELECT 'before.notice',            COUNT(*) FROM `pet_clinic`.`notice`
UNION ALL SELECT 'before.scheduler_lease',   COUNT(*) FROM `pet_clinic`.`scheduler_lease`;

-- ---------------------------------------------------------------------
-- 2. 一条 RENAME TABLE 迁移全部 13 张表
-- ---------------------------------------------------------------------
RENAME TABLE
  `pet_clinic`.`sys_user`         TO `yuzhua`.`sys_user`,
  `pet_clinic`.`pet`              TO `yuzhua`.`pet`,
  `pet_clinic`.`department`       TO `yuzhua`.`department`,
  `pet_clinic`.`doctor`           TO `yuzhua`.`doctor`,
  `pet_clinic`.`admin_user`       TO `yuzhua`.`admin_user`,
  `pet_clinic`.`doctor_schedule`  TO `yuzhua`.`doctor_schedule`,
  `pet_clinic`.`appointment`      TO `yuzhua`.`appointment`,
  `pet_clinic`.`consult_session`  TO `yuzhua`.`consult_session`,
  `pet_clinic`.`consult_message`  TO `yuzhua`.`consult_message`,
  `pet_clinic`.`medical_record`   TO `yuzhua`.`medical_record`,
  `pet_clinic`.`doctor_review`    TO `yuzhua`.`doctor_review`,
  `pet_clinic`.`notice`           TO `yuzhua`.`notice`,
  `pet_clinic`.`scheduler_lease`  TO `yuzhua`.`scheduler_lease`;

-- ---------------------------------------------------------------------
-- 3. 迁移后校验（人工核对）
-- ---------------------------------------------------------------------

-- 3.1 表数：预期 13
SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = 'yuzhua';

-- 3.2 新旧库都还在：预期两行（yuzhua、pet_clinic），旧库只是空库
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name IN ('pet_clinic', 'yuzhua')
ORDER BY schema_name;

-- 3.3 逐表行数：必须与第 1 节 before.* 完全一致
SELECT 'after.sys_user'          AS table_name, COUNT(*) AS row_count FROM `yuzhua`.`sys_user`
UNION ALL SELECT 'after.pet',               COUNT(*) FROM `yuzhua`.`pet`
UNION ALL SELECT 'after.department',        COUNT(*) FROM `yuzhua`.`department`
UNION ALL SELECT 'after.doctor',            COUNT(*) FROM `yuzhua`.`doctor`
UNION ALL SELECT 'after.admin_user',        COUNT(*) FROM `yuzhua`.`admin_user`
UNION ALL SELECT 'after.doctor_schedule',   COUNT(*) FROM `yuzhua`.`doctor_schedule`
UNION ALL SELECT 'after.appointment',       COUNT(*) FROM `yuzhua`.`appointment`
UNION ALL SELECT 'after.consult_session',   COUNT(*) FROM `yuzhua`.`consult_session`
UNION ALL SELECT 'after.consult_message',   COUNT(*) FROM `yuzhua`.`consult_message`
UNION ALL SELECT 'after.medical_record',    COUNT(*) FROM `yuzhua`.`medical_record`
UNION ALL SELECT 'after.doctor_review',     COUNT(*) FROM `yuzhua`.`doctor_review`
UNION ALL SELECT 'after.notice',            COUNT(*) FROM `yuzhua`.`notice`
UNION ALL SELECT 'after.scheduler_lease',   COUNT(*) FROM `yuzhua`.`scheduler_lease`;

-- ---------------------------------------------------------------------
-- 4. 应用账号授权（本脚本不自动执行；由 DBA 按实际账号与来源主机执行）
--    旧授权通常只到 `pet_clinic`.*，迁移后应用账号会连不上新库。
-- ---------------------------------------------------------------------
-- GRANT ALL PRIVILEGES ON `yuzhua`.* TO 'petapp'@'%';
-- FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------
-- 5. 反向迁移 / 回滚块（默认注释；仅在需要把表迁回旧库时取消注释执行）
--    前置：停应用写入；旧库 `pet_clinic` 仍然存在（迁移未 DROP）。
--    若旧库已被删除，先建回同字符集/排序规则的空库。
-- ---------------------------------------------------------------------
-- CREATE DATABASE IF NOT EXISTS `pet_clinic`
--   DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
--
-- RENAME TABLE
--   `yuzhua`.`sys_user`         TO `pet_clinic`.`sys_user`,
--   `yuzhua`.`pet`              TO `pet_clinic`.`pet`,
--   `yuzhua`.`department`       TO `pet_clinic`.`department`,
--   `yuzhua`.`doctor`           TO `pet_clinic`.`doctor`,
--   `yuzhua`.`admin_user`       TO `pet_clinic`.`admin_user`,
--   `yuzhua`.`doctor_schedule`  TO `pet_clinic`.`doctor_schedule`,
--   `yuzhua`.`appointment`      TO `pet_clinic`.`appointment`,
--   `yuzhua`.`consult_session`  TO `pet_clinic`.`consult_session`,
--   `yuzhua`.`consult_message`  TO `pet_clinic`.`consult_message`,
--   `yuzhua`.`medical_record`   TO `pet_clinic`.`medical_record`,
--   `yuzhua`.`doctor_review`    TO `pet_clinic`.`doctor_review`,
--   `yuzhua`.`notice`           TO `pet_clinic`.`notice`,
--   `yuzhua`.`scheduler_lease`  TO `pet_clinic`.`scheduler_lease`;
--
-- 回滚后如需把应用账号授权还原到旧库（按实际账号执行）:
-- GRANT ALL PRIVILEGES ON `pet_clinic`.* TO 'petapp'@'%';
-- FLUSH PRIVILEGES;