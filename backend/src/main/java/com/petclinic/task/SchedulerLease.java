package com.petclinic.task;

import com.petclinic.mapper.SchedulerLeaseMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.UUID;

/**
 * 定时任务的多实例租约。
 *
 * <p>只解决"这一轮谁跑"：抢到租约的实例执行清扫，其余实例直接跳过。
 * 单张预约的正确性仍由预约行锁与条件更新保证，租约退出或重复执行都不会造成重复退号。
 *
 * <p>租期全部用数据库时钟（NOW(3)）计算，而不是 JVM 时间：多台机器时钟漂移时，
 * 用本地时间比较会把"其实还没到期"的租约抢走。三条写语句本身都是原子单行操作，
 * 进程崩溃后租约自然到期，由其他实例通过条件 UPDATE 接管。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SchedulerLease {

    private final SchedulerLeaseMapper leaseMapper;

    /**
     * 进程内固定的持有者标识：主机名/进程号/实例随机后缀。
     * 主机名取不到时用 unknown，不能因此让实例退化成同一个 holder——随机后缀兜住唯一性。
     */
    private final String holder = buildHolder();

    /**
     * 尝试获得租约：先抢首次插入，失败再尝试接管已过期的那一行。
     *
     * @param name       任务名（对应 scheduler_lease.name，最长 64 字符）
     * @param ttlSeconds 本次租约的有效秒数，由数据库时钟计算到期时刻
     * @return true 表示本实例持有租约，可以执行这一轮
     */
    public boolean tryAcquire(String name, long ttlSeconds) {
        if (leaseMapper.insertIfAbsent(name, holder, ttlSeconds) == 1) {
            log.debug("获得定时任务租约：{} holder={}", name, holder);
            return true;
        }
        if (leaseMapper.takeOverExpired(name, holder, ttlSeconds) == 1) {
            log.debug("接管过期定时任务租约：{} holder={}", name, holder);
            return true;
        }
        log.debug("定时任务租约由其他实例持有，本轮跳过：{} holder={}", name, holder);
        return false;
    }

    /**
     * 释放租约：只有 holder 仍是自己时才把 locked_until 设为当前时刻。
     * 返回 0 行说明租约已被其他实例接管，此时必须忽略——否则旧实例会把新实例的租约提前清掉。
     */
    public void release(String name) {
        if (leaseMapper.release(name, holder) == 0) {
            log.debug("租约已被接管，忽略释放：{} holder={}", name, holder);
        }
    }

    private static String buildHolder() {
        String host;
        try {
            host = InetAddress.getLocalHost().getHostName();
        } catch (UnknownHostException e) {
            host = "unknown";
        }
        String raw = host + "/" + ProcessHandle.current().pid() + "/"
                + UUID.randomUUID().toString().substring(0, 8);
        // holder 列宽 128；超长时保留尾部（进程号 + 随机后缀），
        // 避免 INSERT IGNORE 把超长值静默截断后 release 的 holder 条件匹配不上。
        return raw.length() <= 128 ? raw : raw.substring(raw.length() - 128);
    }
}