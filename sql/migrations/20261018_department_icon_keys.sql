-- 科室图标由 emoji 改为前端内置图标的键名，避免各系统 emoji 字形和颜色不一致。
-- 只处理种子科室且 icon 仍是 emoji 的情况，已上传图片或自定义图标的科室保持原值。
UPDATE `department`
SET `icon` = CASE `code`
  WHEN 'NK' THEN 'stethoscope'
  WHEN 'WK' THEN 'surgery'
  WHEN 'PF' THEN 'skin'
  WHEN 'YK' THEN 'eye'
  WHEN 'KQ' THEN 'tooth'
  WHEN 'YX' THEN 'imaging'
  WHEN 'YM' THEN 'vaccine'
  WHEN 'YY' THEN 'nutrition'
  WHEN 'JZ' THEN 'emergency'
  WHEN 'YC' THEN 'exotic'
  ELSE `icon`
END
WHERE `code` IN ('NK','WK','PF','YK','KQ','YX','YM','YY','JZ','YC')
  AND `icon` IS NOT NULL
  AND `icon` <> ''
  AND `icon` NOT LIKE '/%'
  AND `icon` NOT LIKE 'http%';
