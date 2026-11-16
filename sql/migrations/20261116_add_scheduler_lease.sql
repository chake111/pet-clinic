-- =====================================================================
--  20261116_add_scheduler_lease.sql
--  定时任务多实例租约：清扫任务每分钟触发，多实例部署时同一轮只让一个实例执行。
--
--  背景：AppointmentSweepTask 的 expireUnpaid / markMissed 由 @Scheduled 驱动，
--        每个实例都会跑。单张单的退号/改状态本身有条件更新与行锁保护，重复执行
--        不会重复退号，但多实例同时扫同一批候选仍是纯粹的重复劳动与锁竞争。
--        这里用一张单行租约表做"本轮谁跑"的互斥，正确性不依赖 JVM 时钟。
--
--  执行前提：本表不存在时执行一次；重复执行会报
--            ERROR 1050 Table 'scheduler_lease' already exists，
--            这是预期的防重跑信号，不要改成 IF NOT EXISTS 掩盖。
--
--  说明：
--    - 租期全部由数据库计算（NOW(3) 与 DATE_ADD），多台机器时钟不一致也不影响接管；
--    - `holder` 由应用生成（主机名/进程号/实例随机后缀），用于保证只有持有者能
--      提前释放租约，TTL 过期被接管后旧实例不会误删新租约；
--    - 表只有一行一个任务，无需额外索引。
--
--  回退：DROP TABLE `scheduler_lease`;
-- =====================================================================

CREATE TABLE `scheduler_lease` (
  `name`         VARCHAR(64)  NOT NULL COMMENT '任务名',
  `holder`       VARCHAR(128) NOT NULL COMMENT '持有者：主机名/进程号/实例随机后缀',
  `locked_until` DATETIME(3)  NOT NULL COMMENT '租约到期时刻（数据库时钟）',
  `locked_at`    DATETIME(3)  NOT NULL COMMENT '获得或续租时刻（数据库时钟）',
  PRIMARY KEY (`name`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '定时任务多实例租约';

-- ---------------------------------------------------------------------
-- 迁移后自检：应为一行，且表结构包含 holder/locked_until/locked_at
-- ---------------------------------------------------------------------
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'scheduler_lease'
ORDER BY ORDINAL_POSITION;