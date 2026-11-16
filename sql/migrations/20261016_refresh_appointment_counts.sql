-- 部署接诊量更新逻辑时，校正此前未及时更新的存量统计。
UPDATE doctor d SET appointment_count =
  (SELECT COUNT(*) FROM appointment a WHERE a.doctor_id = d.id AND a.deleted = 0 AND a.status = 2)
WHERE d.deleted = 0;
