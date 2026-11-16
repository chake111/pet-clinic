package com.petclinic.it;

import com.petclinic.mapper.SchedulerLeaseMapper;
import com.petclinic.task.SchedulerLease;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 定时任务租约的 DB 语义：首次抢到、未到期不可重入、过期可接管、只有持有者能释放。
 * 所有时间比较都交给数据库 NOW(3)，不依赖 JVM 时钟。
 */
class SchedulerLeaseIT extends MySqlITSupport {

    @Autowired
    private SchedulerLease schedulerLease;

    @Autowired
    private SchedulerLeaseMapper leaseMapper;

    @Test
    void firstAcquireWinsAndSecondIsRejectedUntilTtl() {
        String name = "it.lease.basic";

        assertTrue(schedulerLease.tryAcquire(name, 60), "首次抢租约应成功");
        assertFalse(schedulerLease.tryAcquire(name, 60), "租约未到期时同一实例也不能重入");
        assertEquals(1, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ?", name));
        assertEquals(1, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ? "
                + "AND locked_until BETWEEN DATE_ADD(NOW(3), INTERVAL 55 SECOND) "
                + "AND DATE_ADD(NOW(3), INTERVAL 65 SECOND)", name),
                "locked_until 应由数据库时钟按 TTL 计算");
    }

    @Test
    void releaseMakesLeaseAvailableToAnotherInstance() {
        String name = "it.lease.release";
        assertTrue(schedulerLease.tryAcquire(name, 60));
        schedulerLease.release(name);
        assertEquals(1, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ? "
                + "AND locked_until <= NOW(3)", name), "释放后到期时刻应已到");

        // 第二个实例（holder 不同）随后可以抢到
        SchedulerLease otherNode = new SchedulerLease(leaseMapper);
        assertTrue(otherNode.tryAcquire(name, 60), "释放后另一个实例应能获得租约");
        assertEquals(1, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ? "
                + "AND locked_until > NOW(3)", name));
    }

    @Test
    void expiredLeaseIsTakenOverByCurrentHolder() {
        String name = "it.lease.expire";
        assertTrue(schedulerLease.tryAcquire(name, 60));
        String holder = queryString("SELECT holder FROM scheduler_lease WHERE name = ?", name);

        // 模拟持有者失联：holder 换成别的实例，到期时刻回拨到过去
        jdbc.update("UPDATE scheduler_lease SET holder = 'other-node', "
                + "locked_until = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE name = ?", name);

        assertTrue(schedulerLease.tryAcquire(name, 60), "过期租约应可接管");
        assertEquals(holder, queryString("SELECT holder FROM scheduler_lease WHERE name = ?", name),
                "接管后 holder 应回到当前实例");
        assertNotEquals("other-node", queryString("SELECT holder FROM scheduler_lease WHERE name = ?", name));
        assertEquals(1, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ? "
                + "AND locked_until > NOW(3)", name));
    }

    @Test
    void releaseByNonHolderIsIgnored() {
        String name = "it.lease.foreign";
        assertTrue(schedulerLease.tryAcquire(name, 300));

        // 租约已被其他实例接管，且仍在有效期内：旧实例的释放必须无效
        jdbc.update("UPDATE scheduler_lease SET holder = 'other-node', "
                + "locked_until = DATE_ADD(NOW(3), INTERVAL 60 SECOND) WHERE name = ?", name);

        schedulerLease.release(name);

        assertEquals("other-node", queryString("SELECT holder FROM scheduler_lease WHERE name = ?", name),
                "非持有者释放不应改变租约归属");
        assertEquals(0, queryInt("SELECT COUNT(*) FROM scheduler_lease WHERE name = ? "
                + "AND locked_until <= NOW(3)", name), "非持有者释放不应提前到期");
    }
}