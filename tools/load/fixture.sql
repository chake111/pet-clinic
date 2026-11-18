-- =====================================================================
--  k6 压测固定夹具 (可重复执行)
--  目标库: yuzhua (compose 的 db 容器)
--  约定: 全部使用固定 ID, 不依赖 02_data.sql 的种子数据 id;
--        sys_user 9001 / pet 90001..90100 / doctor 9001 / department 9001
--        schedule 9001 = 100 个号 (race), 9002 = 20 个号 (oversell)
--  清理顺序按引用关系排列: appointment -> doctor_schedule -> pet
--        -> sys_user -> doctor -> department
-- =====================================================================

USE `yuzhua`;
SET NAMES utf8mb4;

-- 1. 清掉上一轮压测留下的数据 (顺序不可颠倒)
DELETE FROM `appointment` WHERE `schedule_id` IN (9001, 9002);
DELETE FROM `doctor_schedule` WHERE `id` IN (9001, 9002);
DELETE FROM `pet` WHERE `id` BETWEEN 90001 AND 90100;
DELETE FROM `sys_user` WHERE `id` = 9001;
DELETE FROM `doctor` WHERE `id` = 9001;
DELETE FROM `department` WHERE `id` = 9001;

-- 2. 科室 / 医生
INSERT INTO `department` (`id`, `name`, `code`, `status`)
VALUES (9001, 'IT内科', 'IT9001', 1);

INSERT INTO `doctor` (`id`, `name`, `department_id`, `consultation_fee`, `status`)
VALUES (9001, 'IT医生', 9001, 80.00, 1);

-- 3. 两条排班: 日期与时段都不同, 避开 uk_doctor_date_period
--    9001: 100 个号, 用于 race 场景 (100 VU 抢 100 个号)
INSERT INTO `doctor_schedule`
    (`id`, `doctor_id`, `work_date`, `period`, `start_time`, `end_time`,
     `total_num`, `remain_num`, `last_queue_no`, `status`)
VALUES
    (9001, 9001, DATE_ADD(CURDATE(), INTERVAL 2 DAY), 3, '18:00:00', '21:30:00',
     100, 100, 0, 1);

--    9002: 20 个号, 用于 oversell 场景 (100 VU 抢 20 个号)
INSERT INTO `doctor_schedule`
    (`id`, `doctor_id`, `work_date`, `period`, `start_time`, `end_time`,
     `total_num`, `remain_num`, `last_queue_no`, `status`)
VALUES
    (9002, 9001, DATE_ADD(CURDATE(), INTERVAL 3 DAY), 2, '13:30:00', '17:30:00',
     20, 20, 0, 1);

-- 4. 压测账号: 明文密码 123456 的 BCrypt hash
INSERT INTO `sys_user`
    (`id`, `username`, `password`, `nickname`, `phone`, `status`, `token_version`)
VALUES
    (9001, 'itload', '$2a$10$0yzLXUNo8OV8t9fBdTlYFumqcM4IBAsInS.neeSzPwQvEtLKjvIGm',
     'IT压测用户', '13900009002', 1, 1);

-- 5. 100 只宠物, id 90001..90100, 与 VU 一一对应 (petId = 90000 + __VU)
INSERT INTO `pet` (`id`, `user_id`, `name`, `species`, `deleted`)
WITH RECURSIVE `seq` (`n`) AS (
    SELECT 1
    UNION ALL
    SELECT `n` + 1 FROM `seq` WHERE `n` < 100
)
SELECT 90000 + `n`, 9001, CONCAT('IT宠物', LPAD(`n`, 3, '0')), '猫', 0
FROM `seq`;