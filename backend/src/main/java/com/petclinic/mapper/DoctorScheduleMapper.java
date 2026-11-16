package com.petclinic.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.petclinic.entity.DoctorSchedule;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 排班号源。
 */
public interface DoctorScheduleMapper extends BaseMapper<DoctorSchedule> {

    /**
     * 抢号。把"检查余量"、"扣减"和"发号"压进同一条 SQL，靠 InnoDB 行锁保证原子性，
     * 因此不需要 Redis 来防超卖。<strong>本表没有逻辑删除列</strong>，删除是物理 DELETE，
     * 所以"号池还在不在"由下单入口的 {@link #selectByIdForUpdate(Long)} 锁内读决定：
     * 删掉之后那把锁的持有者读不到行，也就扣不动号。
     *
     * <p>序号在这里定，不在应用层算：remain_num 回退时 last_queue_no 不回退，
     * 所以取消过的排班不会把同一个号再发给别人。取值必须用
     * {@link #selectLastQueueNoForUpdate(Long)} 的当前读，见该方法的说明。
     *
     * @return 1 抢到了；0 号已满（调用方须回滚事务并提示换号）
     */
    @Update("UPDATE doctor_schedule SET remain_num = remain_num - 1, "
            + "last_queue_no = last_queue_no + 1 "
            + "WHERE id = #{id} AND status = 1 AND remain_num > 0")
    int tryOccupy(@Param("id") Long id);

    /**
     * 读出刚发出去的序号。FOR UPDATE 在这里的作用是<strong>当前读</strong>：
     * REPEATABLE READ 下普通 SELECT 走事务快照，可能仍然看到 tryOccupy 之前的值，
     * 那样序号就会重复。调用方必须与 {@link #tryOccupy} 处于同一事务，
     * 此时行锁已持有，这条语句只改变读取语义、不额外增加等待。
     *
     * 契约动机: 防止重复发号——计数器只增不减让同一个号不发两次，当前读挡掉"读到旧计数再发一遍"。
     *
     * @return 本次占号后的 last_queue_no，即该预约的排队序号
     */
    @Select("SELECT last_queue_no FROM doctor_schedule WHERE id = #{id} FOR UPDATE")
    Integer selectLastQueueNoForUpdate(@Param("id") Long id);

    /**
     * 释放号源：取消预约、支付超时、退款时调用。
     * LEAST 只是防御性封顶，不是幂等机制——一次取消只退一次号由调用方保证
     * （AppointmentService.cancelLocked 在预约行锁内做条件更新，改到行才释放）。
     */
    @Update("UPDATE doctor_schedule SET remain_num = LEAST(remain_num + 1, total_num) "
            + "WHERE id = #{id}")
    int release(@Param("id") Long id);

    /**
     * 锁住排班行再改。<strong>改总量与删除</strong>走它：这两条需要先读到当前值再算
     * （占用数、引用数），拿过期快照会把别人刚抢到的号覆盖掉。
     *
     * <p>停诊与恢复<b>不走</b>这里：它们只写 status、不读余量，互斥由 UPDATE 自身的行锁提供，
     * 与服务层 stopClinic / resumeClinic 的实现一致。
     */
    @Select("SELECT * FROM doctor_schedule WHERE id = #{id} FOR UPDATE")
    DoctorSchedule selectByIdForUpdate(@Param("id") Long id);
}
