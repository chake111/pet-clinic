package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;

/**
 * 医生排班 + 号源池。对应表 doctor_schedule。
 *
 * 防超卖：扣号走 DoctorScheduleMapper#tryOccupy，SQL 在同一条 UPDATE 里
 * 扣减 remain_num 并递增 last_queue_no，靠 InnoDB 行锁 + 影响行数判定是否抢到，返回 0 即表示号已满。
 *
 * last_queue_no 是排队序号的唯一来源：只增不减，取消退号不会让它回退，因此同一排班的序号
 * 不会重复，允许出现空缺。它由服务端维护，改容量、停诊、恢复都不重置，也不接受请求体赋值。
 *
 * 本表无 deleted 列，停诊用 status=0 表达，保证 uk(doctor_id,work_date,period) 不产生历史残留。
 */
@Data
@TableName("doctor_schedule")
public class DoctorSchedule {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long doctorId;
    private LocalDate workDate;

    /** 1 上午 2 下午 3 夜间 */
    private Integer period;
    private LocalTime startTime;
    private LocalTime endTime;
    private Integer totalNum;
    private Integer remainNum;

    /** 已发放的最大排队序号；下单时在当前事务内以当前读取得，不在前端表单里出现 */
    private Integer lastQueueNo;

    private Integer status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
}
