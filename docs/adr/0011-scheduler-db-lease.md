# 清扫任务用数据库租约，不引入 ShedLock

- `scheduler_lease` 一张单行表：`name` 主键、`holder` 持有者、`locked_until` 到期时刻。清扫任务每轮先 `INSERT IGNORE` 抢首次插入，未抢到再 `UPDATE ... WHERE locked_until <= NOW(3)` 接管过期租约；影响 1 行的实例执行本轮，其余实例跳过。
- 时间比较全部用数据库 `NOW(3)`，不用 JVM 时钟。多台机器时钟漂移时，本地时间会把还没到期的租约抢走。
- 释放带 `holder` 条件：租约已被别的实例接管时，旧实例的释放影响 0 行，不会提前清掉新租约。
- 租约只决定"谁跑这一轮"，不承担业务正确性。单张预约的取消/退号仍由预约行锁与条件更新保证；租约失效或重复执行最坏是重复劳动，不会重复退号。
- 租期默认 300 秒（`petclinic.scheduler.lease-seconds`），不续期。正常一轮远小于它；实例崩溃后最多 5 分钟由其他实例接管。
- 不引 ShedLock：它解决的正是同一问题，但项目只有两个 `@Scheduled` 任务、唯一共享资源就是同一个 MySQL，为它加两个依赖和一层 AOP 不划算；租约表的三条单行写更容易在现有 Testcontainers 集成测试里验证接管与误释放。任务数量和协调需求增长到需要 cron 级治理时再换。
- WebSocket 的会话注册表仍在进程内，租约不解决它；多实例部署仍需要粘性会话或共享通道。

代码依据：`task/SchedulerLease`、`mapper/SchedulerLeaseMapper`、`task/AppointmentSweepTask`、`sql/01_schema.sql` 的 `scheduler_lease`；测试见 `SchedulerLeaseIT`、`AppointmentSweepTaskTest`。