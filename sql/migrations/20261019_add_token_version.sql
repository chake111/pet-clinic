-- 令牌撤销：账号增加令牌版本，改密时递增，此前签发的 JWT 立即失效。
--
-- 部署顺序：本迁移先于应用发布执行。列带默认值 1，存量账号自动获得版本 1；
-- 应用发布后，缺少 ver 声明的旧令牌一律被 AccountGuard 拒绝，等同于要求重新登录。
--
-- 回退：保留本列即可（旧版本应用不读取它）。若要彻底撤销旧令牌，
-- 不要回退本列，而是轮换 yuzhua.jwt.secret。

ALTER TABLE `sys_user`
  ADD COLUMN `token_version` INT NOT NULL DEFAULT 1
    COMMENT '令牌版本，改密递增，旧令牌版本落后即失效' AFTER `status`;

ALTER TABLE `admin_user`
  ADD COLUMN `token_version` INT NOT NULL DEFAULT 1
    COMMENT '令牌版本，改密递增，旧令牌版本落后即失效' AFTER `status`;
