# 下单幂等键落在预约表上，同键重放返回原单

- 客户端在 `POST /client/appointment` 带可选头 `Idempotency-Key`，长度 8–64，字符集 `[A-Za-z0-9._:-]`；不传时保持旧行为。
- `appointment` 加可空列 `idem_key` 与唯一索引 `uk_user_idem (user_id, idem_key)`。键按用户隔离，避免用别人的键读到别人的预约。
- 不建独立幂等表：只有下单一个入口需要，结果就是预约单本身。独立表还要再存一次请求指纹、响应快照与处理状态，多一份写放大和过期清理，收益不抵复杂度。
- 同键重放返回首次落库的原单，即使本次请求的宠物或时段不同；客户端换意图时换键，服务端只记 WARN，不报冲突。报错会让"响应丢了、用户改了下表单再点一次"的场景拿到错误，而原单其实已经存在。
- 并发路径分三层：事务外按 `(userId, key)` 预查（重试快路径，也覆盖时段已过期/已删除的情况）；拿到排班行锁后再查一次（并发同键在这里收敛）；最后靠唯一索引兜底。唯一键冲突时事务先回滚（扣号与发号计数器一起退回），再在事务外回读原单。
- 并发同键的第二个请求即使换了参数，也先在排班锁内回读原单，再做宠物/医生/症状校验；校验失败后再回读一次，避免把并发首单尚未提交的窗口误报成坏请求。
- 列可空、索引允许多个 NULL，历史单与旧客户端不需要回填。`idem_key` 用 `utf8mb4_bin`，键值按字节比较。
- 已知边界：当前没有删除预约单的入口，逻辑删除行不会挡住同键重新下单；将来若支持删除，需要同时清空 `idem_key` 或调整索引。不带键的旧客户端没有幂等保护，只走原有"同一宠物同一时段只一单"的业务去重。

代码依据：`AppointmentService.create(req, idemKey)` 与 `replayOf`、`AppointmentMapper.selectByUserAndIdemKey`、`sql/01_schema.sql` 的 `uk_user_idem`；前端 `frontend/src/utils/idempotencyKey.js`、`frontend/src/views/client/Booking.vue`。