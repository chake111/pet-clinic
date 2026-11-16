# 首轮工程审计：问诊推送权限、并发收尾与测试入口

2026-10-19，源码基线 `7f6767f`。首轮范围：业务正确性、认证与权限、交付质量。

共确认 **5 条缺陷（Bug）**：认证与权限 2 条、业务正确性 1 条、交付质量 2 条，全部为 `[实测]`。优先处理 F1、F2 的推送权限。

| 编号 | 优先级 | 维度 | 已复现行为 |
|---|---|---|---|
| F1 | P1 | 认证与权限 | 账号停用或令牌过期后，原 WebSocket 继续接收医生消息 |
| F2 | P1 | 认证与权限 | 整场会话已屏蔽，恢复其中一条消息仍向旧订阅推送正文 |
| F3 | P2 | 业务正确性 | 结束会话与发消息交错，先发结束通知，再确认消息；摘要被较早消息覆盖 |
| F4 | P2 | 交付质量 | 前端规则测试调用已移除的 `remark`，后续回归断言中断 |
| F5 | P2 | 交付质量 | 集成测试对最新建表结构重复执行迁移，因重复列中断 |

## 环境与取证方法

- 独立 MySQL 8.0.38，绑定 `127.0.0.1:3307`，库 `pet_clinic_test_f7a02549`，专用账号仅有该库权限；由当前 `01_schema.sql` 与 `02_data.sql` 初始化。
- 后端由当前源码副本全量编译打包，独立运行在 `http://127.0.0.1:8082/api`。113 个后端源文件与仓库逐文件比较一致，见 [源码核验](source-verification.json)。
- 定向验证记录了 78 次 REST 请求及 WebSocket 帧。另执行 5 个演示账号的真实登录，确认登录结果的账号、角色、医生绑定与测试身份一致。定向请求使用隔离环境签发的测试令牌，过期场景专门使用 2 秒有效期令牌。日志不含令牌与密码。
- 并发验证最多同时发起 4 次下单。F3 使用一次约 700 ms 的测试行锁，安排两个请求交错。
- [52 个写接口静态地图](write-endpoints.md)列出全局登录体系、控制器角色限制和服务调用。运行验证覆盖下文列出的核心链路与权限组合。
- 本轮未运行浏览器交互；前端验证使用仓库现有 Node 脚本与读取实际组件逻辑的临时探针。

## F1 · [实测] 缺陷（Bug）· P1：失效账号的原连接仍接收消息

**铁证。** [ConsultWebSocketHandler.java:83](../../../../backend/src/main/java/com/petclinic/websocket/ConsultWebSocketHandler.java) 在接收客户端帧时检查账号：

```java
if (!accountGuard.active(conn.getUser())) {
    // 返回错误并关闭连接
}
```

发送端 [ConsultWebSocketHandler.java:217](../../../../backend/src/main/java/com/petclinic/websocket/ConsultWebSocketHandler.java) 根据旧房间订阅广播：

```java
List<Conn> targets = registry.inRoom(roomId);
// 遍历 targets 后调用 write(c, payload)
```

[ConsultWebSocketHandler.java:230](../../../../backend/src/main/java/com/petclinic/websocket/ConsultWebSocketHandler.java) 直接 `sendMessage(...)`；REST 事件的另一发送出口 [ConsultPush.java:42](../../../../backend/src/main/java/com/petclinic/websocket/ConsultPush.java) 同样遍历旧订阅。全局搜索 `accountGuard`、`active`、`sendMessage`、`registry.close` 后，确认账号检查位于 REST、握手、入站帧，账号停用没有同步清退连接。

**复现。** 前提：主人 `zhangsan` 与所属医生 `doctor01` 已进入同一未结束问诊，本次会话 ID 为 4。

1. 主人和医生连接 `ws://127.0.0.1:8082/api/ws/consult?token=<各自令牌>&sessionId=4`，等待 `HISTORY`。
2. 管理员请求 `PUT /api/admin/user/1/status?status=0`，返回 `code=200`。
3. 主人请求 `GET /api/client/consult/sessions/4`，返回 `code=401`。
4. 主人保持原连接，暂停发送客户端帧。医生发送：

```json
{"type":"CHAT","sessionId":4,"msgType":"TEXT","content":"AUDIT_AFTER_DISABLE","requestId":"disabled-recipient"}
```

**期望：** 停用账号停止收到新问诊内容。**实际：** 主人收到 `MSG`，包含 `AUDIT_AFTER_DISABLE`，连接仍开放。使用 2 秒令牌、等待 2.4 秒后再发送 `AUDIT_AFTER_EXPIRY`，结果相同。

证据：[停用后的消息](evidence.jsonl)、[过期后的消息](evidence.jsonl)。实际影响是失效账号继续收到后续诊疗内容。

**最小止血与验证。** 清退失效账号的存量连接；两个出站出口发送前复用账号有效性检查。本轮实测：给停用连接发送一次 `PING`，现有入站校验将其关闭；随后新握手被 HTTP 401 拒绝，见 [关闭对照](evidence.jsonl)与[重连对照](evidence.jsonl)。默认前端每 30 秒发送心跳，位置为 [consultSocket.js:97](../../../../frontend/src/utils/consultSocket.js)；服务端权限收回需要覆盖保持静默的客户端。

修复验收断言：停用、令牌到期分别重复上述流程，失效连接收到的新业务帧数量为 0，合法对端的发送与历史查询保持成功。源码修复尚未实施。

## F2 · [实测] 缺陷（Bug）· P1：会话屏蔽后，恢复消息泄露正文

**铁证。** 当前规则在 [ConsultService.java:168](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 拒绝参与方读取被处置会话：

```java
if (s.getModerateStatus() != null && s.getModerateStatus() != ConsultSession.MV_NORMAL) {
    throw BizException.notFound("问诊会话");
}
```

恢复消息时，[ConsultService.java:394](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 将消息对象放入广播：

```java
consultPush.push(m.getSessionId(), Map.of("type", "MESSAGE_VISIBILITY", "sessionId", m.getSessionId(),
        "messageId", messageId, "hidden", hidden, "message", hidden == 0 ? m : Map.of()));
```

整场处置在 [ConsultService.java:448](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 发送 `MODERATION`。全局核对 [ConsultSocketRegistry.java:75](../../../../backend/src/main/java/com/petclinic/websocket/ConsultSocketRegistry.java) 与 `ConsultPush` 后，确认既有房间订阅仍被用于发送正文。

**复现。** 前提：新会话 ID 7，所属医生发送消息 ID 22，正文为 `AUDIT_HIDDEN_BEFORE_JOIN`。

1. 管理员 `PUT /api/admin/consult/message/22/hidden?hidden=1&reason=audit`。
2. 主人再进入会话。历史查询不含消息 22。
3. 管理员 `PUT /api/admin/consult/7/moderate?moderateStatus=2&reason=audit`。主人保留原协议连接。
4. 主人 `GET /api/client/consult/7/messages`，返回 `code=404`。
5. 管理员 `PUT /api/admin/consult/message/22/hidden?hidden=0`。

**期望：** 屏蔽会话的参与方收不到正文。**实际：** 主人收到 `MESSAGE_VISIBILITY`，其中 `message.content` 为上述正文；数据库仍为 `status=2, moderate_status=2`。主人首次进入时未获得该消息，内容在权限收回后首次到达。

完整证据：[evidence.jsonl:151](evidence.jsonl)。前端对 `MODERATION` 有界面清理逻辑，已检查 [ConsultPanel.vue:198](../../../../frontend/src/components/ConsultPanel.vue)；本次保留协议连接验证服务端的可见性规则。

**最小止血与验证。** 对已处置会话，恢复消息时跳过向参与方发送正文；处置提交后清退该房间的订阅。实测断开旧连接后重新订阅，会收到“问诊会话不存在”，未收到 `HISTORY`，见 [重连对照](evidence.jsonl)。修复验收：重复上述 5 步，旧连接收不到恢复正文，管理员审计查询仍可读取该消息。

## F3 · [实测] 缺陷（Bug）· P2：问诊收尾与消息保存未串行化

**铁证。** [ConsultService.java:276](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 读取会话后判断状态，读取入口 [ConsultService.java:157](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 使用普通 `getById`。随后 [ConsultService.java:316](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java)：

```java
messageMapper.insert(m);
baseMapper.touchOnMessage(s.getId(), preview(type, text), byDoctor, !peerOnline);
```

后者 SQL 在 [ConsultSessionMapper.java:18](../../../../backend/src/main/java/com/petclinic/mapper/ConsultSessionMapper.java)：

```sql
UPDATE consult_session SET last_message = #{preview}, last_message_time = NOW(), ...
WHERE id = #{sessionId}
```

结束路径在 [ConsultService.java:142](../../../../backend/src/main/java/com/petclinic/service/ConsultService.java) 条件更新状态，再插入结束提示。已核对事务注解、Mapper 和 [ConsultPush.java:26](../../../../backend/src/main/java/com/petclinic/websocket/ConsultPush.java) 的 `afterCommit`：结束通知确实在提交后发送，发送消息的事务仍可基于此前读取的状态继续提交。

**复现。** 前提：主人已订阅未结束会话 ID 5。仅在隔离库执行：

```sql
START TRANSACTION;
SELECT id FROM consult_session WHERE id=5 FOR UPDATE;
```

1. 医生发起 `POST /api/admin/consult/5/close`，请求体 `{"summary":"AUDIT_CLOSED"}`，使其等待会话行锁。
2. 约 350 ms 后，主人发送 `CHAT`，正文 `AUDIT_RACE_MESSAGE`，`requestId=race-close-send`。
3. 再等待约 350 ms，释放测试事务 `COMMIT`。这两个请求在等待期间均已读取旧状态。

**期望：** 消息保存与会话结束按同一会话顺序提交；结束后的摘要与已提交消息顺序一致。**实际：** 收到 `SESSION status=2`、关闭接口 `code=200`，随后收到 `MSG` 和成功 `ACK`。数据库消息顺序为 ID 20 用户消息、ID 21 结束提示；`consult_session.last_message` 却为 ID 20 的 `AUDIT_RACE_MESSAGE`。

证据：[请求、事件顺序与落库结果](evidence.jsonl)。实际影响：结束提示之后仍出现发送成功回执，列表摘要与历史末条消息不一致。

**最小止血与验证。** 发送消息、接诊、结束及处置时，先锁同一会话行，再在锁内检查状态并完成写入。对照验证已执行：关闭完成后再发送，收到“问诊已结束，会话已关闭”，消息落库数为 0，见 [串行对照](evidence.jsonl)。修复验收：重放锁控制的交错，消息要么先于结束提交，要么返回失败；最终摘要对应最后一条有效消息。源码修复尚未实施。

## F4 · [实测] 缺陷（Bug）· P2：前端规则测试引用已移除函数

**铁证。** [business-rules.test.mjs:125](../../../../frontend/tests/business-rules.test.mjs)：

```js
}, 'return { remark }')
assert.equal(mySchedule.remark(...), '已停诊')
```

当前 [MySchedule.vue:23](../../../../frontend/src/views/admin/MySchedule.vue) 实现为：

```js
const slotState = row => row.doctorAvailable === false || row.status !== 1 ? { label: '已停诊', tone: 'danger' }
  : slotEnded(row, now.value.date, now.value.hhmm) ? { label: '已结束', tone: 'terminated' }
  : row.remainNum <= 0 ? { label: '已约满', tone: 'warning' } : { label: '可预约', tone: 'success' }
```

全局搜索确认页面及其导入中没有 `remark` 函数；测试的动态执行器也没有注入该名称。

**复现。** 在仓库根目录执行：

```powershell
node --test frontend/tests/*.test.mjs
```

**期望：** 全部脚本执行到末尾。**实际：** 按文件统计 2 通过、1 失败，`ReferenceError: remark is not defined`，退出码 1。[原始输出](frontend-baseline.txt)。位于第 130 行之后的 ACK、发送失败、断连拒绝断言因中断而未运行。

**最小止血与验证。** 测试提取 `slotState`，对返回的 `.label` 断言，并把旧文案“时段已结束”对齐为“已结束”。本轮临时探针读取当前组件，停诊、结束、可预约、约满 4 种状态均通过；另单独执行原脚本下游的 ACK、ERROR、断连断言，全部通过。见 [controls.txt](controls.txt)。其中下游代码保留了原脚本的汇总打印文字，实际执行范围以 `DOWNSTREAM_SOCKET_CHECK_PASS` 记录为准。

正式验收要求原命令退出码为 0，并执行到下游断言。原测试文件保持原样。

## F5 · [实测] 缺陷（Bug）· P2：最新结构上的集成回归重复执行迁移

**铁证。** [business_rules_check.mjs:120](../../../../tools/business_rules_check.mjs)：

```js
const migration = readFileSync(new URL('../sql/migrations/20261016_unique_active_phone.sql', import.meta.url), 'utf8')
sql(migration)
```

[迁移 SQL:7](../../../../sql/migrations/20261016_unique_active_phone.sql) 执行 `ADD COLUMN active_phone`。当前 [01_schema.sql:42](../../../../sql/01_schema.sql) 已创建该列，第 45 行已创建唯一索引。已核对测试入口、快照工具和迁移调用，测试运行前没有结构版本判断。

**复现。** 使用当前建表脚本和种子数据初始化上述隔离库，配置 `runtime.json`、受限数据库凭据、测试 JWT 与角色信息，启动 8082 后端。在仓库根目录执行：

```powershell
node tools/business_rules_check.mjs <runtime.json>
```

**期望：** 最新结构完成整套业务回归。**实际：** 前 5 组打印 `PASS` 后，在第 121 行退出：

```text
ERROR 1060 (42S21) at line 7: Duplicate column name 'active_phone'
```

[原始日志](existing-suite.txt)。后续公告、逾期接诊、会话分页、在线状态及治理回归均未执行；脚本结束前已写入的测试数据需要恢复。

**最小止血与验证。** 将迁移验证安排在明确的迁移前结构中；当前结构上的业务回归直接验证唯一约束。本轮恢复隔离库快照，然后仅在测试库移除 `uk_active_phone` 与 `active_phone`，构造迁移前结构。未修改原脚本，重新运行后 13 组 `PASS`，最终 `BUSINESS RULES INTEGRATION PASSED`，退出码 0。见 [迁移前结构对照](existing-suite-legacy-control.txt)。日志中 `ERROR 1062 Duplicate entry` 来自测试故意制造的重复手机号，紧接的断言通过。

正式验收须同时覆盖“当前建表结构直接回归”和“迁移前结构执行迁移后回归”。本轮已经分别保留失败与通过两组结果。

## 已通过的核心验证

[appointments.txt](appointments.txt) 与 [verify.txt](verify.txt) 保留请求和数据库查询结果：

- 同宠物同排班 4 次并发下单：1 次成功；最后一个号源面对 3 次请求：1 次成功，余量 0、排队序号无重复。
- 重复支付状态稳定；主人与管理员并发取消同一预约：1 次成功、号源仅退回 1 个。
- 未支付接诊与未接诊写病历被拒绝；并发保存病历返回同一个 ID，库中有效病历 1 份；并发评价最终 1 条，重复请求返回业务错误。
- 其他主人访问、修改、删除宠物，读取、支付、取消预约，读取病历与会话均被拒绝。其他医生的预约接诊、取消、病历写入、评价回复被拒绝；管理员代接诊、代完成、写病历及删除病历被拒绝。
- 非参与方 WebSocket 订阅、发消息、已读请求均被拒绝，新增消息数量为 0。
- 超过付款期限的支付被拒绝；已支付过期预约取消时落为未到诊，付款状态与号源保持。

本轮在上述预约、病历、评价验证场景中未发现实质缺陷。

## 不要动的地方：已确认的取舍（Tradeoff）

- **停诊保留已成交预约和余量。** [DoctorScheduleService.java:297](../../../../backend/src/main/java/com/petclinic/service/DoctorScheduleService.java) 所在 `stopClinic` 仅更新状态；本轮验证已有预约和余量均保持。当前单店流程由工作人员联系改约。
- **已支付未到诊保留付款和号源占用。** [AppointmentService.java:426](../../../../backend/src/main/java/com/petclinic/service/AppointmentService.java) 的状态规则与本轮结果一致，应保留。
- **单机内存连接登记表。** [ConsultSocketRegistry.java:18](../../../../backend/src/main/java/com/petclinic/websocket/ConsultSocketRegistry.java) 明确单店单机假设。F1、F2 可在现有连接和发送路径内修复。

## 产物、恢复与后续顺序

审计脚本副本、源码摘录与日志位于本报告同目录。实际复现环境位于 `<temp>\pet-audit-stage2-20261019-7f6767f`，其中保留运行配置、随机测试凭据、数据库目录和源码副本。归档中不复制凭据文件。脚本重跑需在该临时环境目录内执行，并先启动隔离 MySQL 与后端；原环境配置中的数据库名必须与 `SELECT DATABASE(), @@port` 的结果一致。`audit-lib.mjs` 对每次数据库操作及 REST 请求执行该检查。

本轮结束前已停止隔离后端，恢复运行前数据库快照，再次导出逐字节比较一致；随后停止隔离 MySQL。结果见 [cleanup.json](cleanup.json)。8082、3307 均已释放；原 8081、5173、3306 进程保持运行。Git 跟踪文件无变更，审计产物保存在被忽略的 `.tmp/` 下。

第一轮发现集中在问诊推送与收尾，以及两条失效测试入口。建议先按 F1/F2 → F3 → F4/F5 修复并重放对应探针，再扩展数据层的并发聚合与前后端契约。当前修复建议均未写入项目源码。
