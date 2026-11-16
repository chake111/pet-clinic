-- =====================================================================
--  20261116_add_appointment_idem_key.sql
--  下单幂等键：同一用户携带同一个客户端生成的键，只允许落一张预约单。
--
--  背景：前端重试（网络抖动、用户连点、代理重发）会重复提交同一次下单。
--        仅靠"同一宠物同一时段只一单"只能挡住一部分请求：换宠物、换时段的重放
--        仍会产生新单并多扣号源。客户端在请求头带 Idempotency-Key 后，
--        服务端按 (user_id, idem_key) 查回原单直接返回，不再占号。
--
--  执行前提：停写执行一次（列/索引不存在时执行；重复执行会报
--            ERROR 1060 Duplicate column / ERROR 1061 Duplicate key name，
--            这是预期的防重跑信号，不要改成 IF NOT EXISTS 掩盖）。
--
--  兼容性：MySQL 唯一索引允许多个 NULL，因此历史单与未带键的普通下单
--          不需要回填 idem_key；它们在这条索引下互不冲突。
--          idem_key 用 utf8mb4_bin，键值按字节精确比较（大小写不同视为不同键），
--          与客户端生成的不透明随机串语义一致。
--
--  回退：ALTER TABLE `appointment` DROP INDEX `uk_user_idem`,
--        DROP COLUMN `idem_key`;
-- =====================================================================

ALTER TABLE `appointment`
  ADD COLUMN `idem_key` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT '下单幂等键，客户端生成；同用户同键只落一单' AFTER `order_no`,
  ADD UNIQUE KEY `uk_user_idem` (`user_id`, `idem_key`);

-- ---------------------------------------------------------------------
-- 迁移后自检：以下两类查询都应为 0 行
-- ---------------------------------------------------------------------

-- (1) 同一用户同一非空键不得出现多行
SELECT `user_id`, `idem_key`, COUNT(*) AS copies
FROM `appointment`
WHERE `idem_key` IS NOT NULL
GROUP BY `user_id`, `idem_key`
HAVING COUNT(*) > 1;

-- (2) 索引确实建出来了（应为一行 uk_user_idem）
SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'appointment'
  AND INDEX_NAME = 'uk_user_idem'
ORDER BY SEQ_IN_INDEX;