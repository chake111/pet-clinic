-- 在目标业务库中执行。先核对下面列出的重复号码及账号，由账号所属人确认后修正。
-- 若仍存在重复，ALTER 会失败，原手机号保留。
SELECT TRIM(phone) AS phone, GROUP_CONCAT(id ORDER BY id) AS user_ids
FROM sys_user WHERE deleted = 0 AND NULLIF(TRIM(phone), '') IS NOT NULL
GROUP BY TRIM(phone) HAVING COUNT(*) > 1;

ALTER TABLE sys_user
  ADD COLUMN active_phone VARCHAR(20)
    GENERATED ALWAYS AS (IF(deleted = 0, NULLIF(TRIM(phone), ''), NULL)) STORED,
  ADD UNIQUE KEY uk_active_phone (active_phone);
