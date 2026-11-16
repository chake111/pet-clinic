package com.petclinic.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

/**
 * 定时任务多实例租约。
 *
 * <p>三条写语句都是单行原子操作，成败由影响行数判定，不需要额外锁：
 * INSERT IGNORE 抢首次插入，两条条件 UPDATE 分别处理"过期接管"与"持有者释放"。
 * 租期统一由数据库时钟 NOW(3) 计算，多实例部署时不受各机器时钟漂移影响。
 */
public interface SchedulerLeaseMapper {

    /** 首次抢租约。name 已存在时 INSERT IGNORE 影响 0 行，不报唯一键错误。 */
    @Insert("INSERT IGNORE INTO scheduler_lease (name, holder, locked_until, locked_at) "
            + "VALUES (#{name}, #{holder}, DATE_ADD(NOW(3), INTERVAL #{ttlSeconds} SECOND), NOW(3))")
    int insertIfAbsent(@Param("name") String name, @Param("holder") String holder,
                       @Param("ttlSeconds") long ttlSeconds);

    /** 接管已过期（或已被释放）的租约。只有 locked_until <= NOW(3) 的那一行会被改到。 */
    @Update("UPDATE scheduler_lease SET holder = #{holder}, "
            + "locked_until = DATE_ADD(NOW(3), INTERVAL #{ttlSeconds} SECOND), locked_at = NOW(3) "
            + "WHERE name = #{name} AND locked_until <= NOW(3)")
    int takeOverExpired(@Param("name") String name, @Param("holder") String holder,
                        @Param("ttlSeconds") long ttlSeconds);

    /** 持有者提前释放：holder 不匹配（租约已被别的实例接管）时影响 0 行。 */
    @Update("UPDATE scheduler_lease SET locked_until = NOW(3) "
            + "WHERE name = #{name} AND holder = #{holder}")
    int release(@Param("name") String name, @Param("holder") String holder);
}