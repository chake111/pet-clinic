package com.yuzhua.task;

import com.yuzhua.config.AppProperties;
import com.yuzhua.service.AppointmentService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;

import java.util.List;
import java.util.function.Predicate;

/**
 * 预约单的状态清扫。
 *
 * 单店系统不引消息队列，超时释放用最直白的轮询：一分钟一次，
 * 只处理创建时间早于超时线的单，所以扫描量始终是"未支付存量"而不是全表。
 * 两张表都只在这里排期，动作本身走 AppointmentService 的同一套锁内复核路径。
 *
 * 循环留在本类、一单一事务，不是为了好看：Spring 的 {@code @Transactional} 靠代理生效，
 * 同类内互相调用不会开新事务，而整批共用一个事务实测会死锁——清扫一边握着已处理单的
 * 排班行锁一边去锁下一张预约，与用户取消"先锁预约再退号"的顺序相反
 * （.tmp/t2c/t4-01/backend-8082.log 里的 1213）。逐单事务同时最多持有一张预约 + 一行排班，
 * 锁顺序恒定，一张单失败也不牵连整批。
 *
 * <p>多实例部署时每台都会按同样的 cron 触发，所以每轮先抢 DB 租约（{@link SchedulerLease}）：
 * 只有抢到的实例真正扫描。租约只解决"谁跑这一轮"，单张单的正确性仍由预约行锁与条件更新保证；
 * 租期 300s 远大于正常一轮耗时，进程挂掉最多 5 分钟后由其他实例接管；
 * 若一轮真的超过租期，最坏也只是重复劳动，不会重复退号。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AppointmentSweepTask {

    private final AppointmentService appointmentService;
    private final SchedulerLease schedulerLease;
    private final AppProperties props;

    /** 超时未支付 → 自动取消并把号源退回池子 */
    @Scheduled(fixedDelay = 60_000, initialDelay = 30_000)
    public void expireUnpaid() {
        withLease("appointment.expire-unpaid", () ->
                sweep("未支付超时", appointmentService.unpaidOverdueIds(), appointmentService::expireOne));
    }

    /** 过就诊日仍是"待接诊 + 已支付"的记为未到诊（R3）；已接诊的单留原状，未支付的归上面那条管 */
    @Scheduled(cron = "0 30 0 * * ?")
    @EventListener(ApplicationReadyEvent.class)
    public void markMissed() {
        withLease("appointment.mark-missed", () ->
                sweep("未到诊标记", appointmentService.staleVisitIds(), appointmentService::markMissedOne));
    }

    /** 拿到租约才执行本轮；拿不到直接跳过，交给持有租约的实例。 */
    private void withLease(String name, Runnable action) {
        long ttlSeconds = props.getScheduler().getLeaseSeconds();
        if (!schedulerLease.tryAcquire(name, ttlSeconds)) {
            log.debug("定时任务租约被其他实例持有，本轮跳过：{}", name);
            return;
        }
        try {
            // sweep 内部逐单 catch：单张失败继续下一张；候选查询异常会冒泡并在这里释放租约，交给下一轮。
            action.run();
        } finally {
            // 无论本轮成功与否都释放，避免让其他实例白等到 TTL 到期
            schedulerLease.release(name);
        }
    }

    private void sweep(String what, List<Long> ids, Predicate<Long> perOrder) {
        if (ids.isEmpty()) {
            return;
        }
        int done = 0;
        for (Long id : ids) {
            try {
                if (perOrder.test(id)) {
                    done++;
                }
            } catch (Exception e) {
                log.error("{}：处理预约 {} 失败，留给下一轮", what, id, e);
            }
        }
        if (done > 0) {
            log.info("{}：候选 {} 单，本次处理 {} 单", what, ids.size(), done);
        }
    }
}
