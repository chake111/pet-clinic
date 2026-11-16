# 首轮审计修改实施与复验结果

日期：2026-10-19  
源码基线：`7f6767f`（工作区修改未提交）  
计划：[修改计划.md](修改计划.md)  
审计报告：[REPORT.md](REPORT.md)

## 1. 结论

F1—F5 全部实施完成，隔离环境复验通过：

| 编号 | 修复内容 | 复验结果 |
|---|---|---|
| F1 | 出站帧发送前统一校验账号与会话准入 | 停用账号、过期令牌收到的新业务帧为 0，连接以 1008 关闭；重连 401 |
| F2 | 处置事务提交后清退房间订阅 | 原连接只收到 MODERATION，恢复正文为 0；其他房间仍可收发；审计视图仍可读 |
| F3 | 问诊写操作按会话行锁串行化 | 两种锁顺序均符合预期；屏蔽旧消息与等待期间新消息定序正确；摘要与最后可见消息一致；事务回滚无通知/清退 |
| F4 | 前端规则断言对齐 `slotState` | `node --test frontend/tests/*.test.mjs` 三份脚本全部通过，退出码 0 |
| F5 | 按当前结构选择迁移/直接验证 | 当前结构与迁移前结构均完整通过；异常结构明确报差异并退出 1 |

## 2. 代码改动

### F1 / F2：推送权限

新增 `backend/src/main/java/com/petclinic/websocket/ConsultDeliveryGuard.java`：

- `checkBusiness`：账号有效 + 会话存在 + 接收方仍是主人/医生 + 会话未被处置。
- `checkParticipant`：处置通知专用，只验账号与原参与方，不限制处置状态。
- `checkAccount`：READY / PONG / 普通 ERROR 只验账号与令牌。
- 三个方法均使用 `REQUIRES_NEW` 只读事务，保证 `afterCommit` 回调读到提交后的新状态。

`ConsultPush` 收敛为唯一发送出口：

- `push` / `send`：业务帧，事务提交后发送；发送前调用 `checkBusiness`。
- `pushModeration`：提交后先发 MODERATION，`finally` 中清退该房间订阅。
- `sendControl`：控制帧只验账号。
- 账号失效时直接 `close(1008)`，不先写错误帧，避免递归；会话准入失败只丢当前帧并清退房间。

`ConsultWebSocketHandler`：

- 所有业务帧显式传入 `sessionId`：HISTORY / PRESENCE / MSG / ACK / READ；READY / PONG / ERROR 走控制帧。
- `join` 先执行 `requireMember`，再判断是否已登记房间；已订阅连接也会重新校验。

`ConsultSocketRegistry` 新增 `leaveRoom`，只移除单个房间，连接与其他房间保留。

`ConsultService`：非零处置改走 `pushModeration`；`changeMessageHidden` 的恢复帧受统一会话准入检查约束。

### F3：会话行锁

- `ConsultSessionMapper.selectByIdForUpdate`：`SELECT * FROM consult_session WHERE id = ? FOR UPDATE`。
- `ConsultMessageMapper.selectByIdForUpdate`：锁内当前读消息，避免 REPEATABLE READ 旧快照。
- `ConsultService` 拆分 `requireMember`：
  - 读接口用普通读取；
  - `accept` / `close` / `send` / `markRead` 先 `lockMember`（锁会话后校验）；
  - `moderate` 先 `lockSession`（管理员不是参与方）；
  - `changeMessageHidden` 普通读定位会话 → 锁会话 → 锁消息当前读。
- 锁顺序统一为 **会话行 → 消息行**。`systemMessage` 与 `refreshSessionAggregates` 均在持锁事务内调用。
- 摘要重算的“最后一条可见消息”改用 `selectLastVisibleForUpdate` 当前读。屏蔽事务可能在等会话锁之前已执行普通读并建立旧快照，普通查询会漏掉等待期间提交的新消息，把 `last_message` 误清为 NULL。
- 新增定序回归：先让新消息在锁上排队、屏蔽请求随后建立旧快照并等待；释放锁后新消息先提交，屏蔽再执行，断言摘要指向新消息且未读一致。

### F4：前端测试

`frontend/tests/business-rules.test.mjs:122` 起改为提取 `slotState`，断言 `已停诊 / 已结束 / 可预约 / 已约满` 四种 `.label`，保留后续真实 `ConsultSocket` 的 ACK、ERROR、断连断言。

### F5：集成迁移判断

`tools/business_rules_check.mjs` 在执行迁移前查询 `information_schema.COLUMNS` 与 `STATISTICS`：

| 结构 | 动作 |
|---|---|
| 列与索引都不存在 | 执行迁移，随后重新查询并校验 |
| 列与索引都存在 | 跳过迁移，直接校验 |
| 只有其一 | 输出 `STRUCTURE ERROR` 并以 1 退出 |

校验项：`varchar(20)`、`STORED GENERATED`、生成表达式语义（归一化反引号/字符集前导/反斜杠/空白/括号）、索引 `NON_UNIQUE=0` 且仅含 `active_phone`。

## 3. 验证结果

环境：MySQL 8.0.38 `127.0.0.1:3307`，库 `pet_clinic_test_f7a02549`，受限账号 `audit`；后端 `127.0.0.1:8082`，由修改后源码打包运行。

### 3.1 前端

| 检查 | 命令 | 结果 |
|---|---|---|
| Node 测试 | `node --test frontend/tests/*.test.mjs` | 3/3 通过，退出码 0 |
| CSS 契约 | `node scripts/check-css.mjs` | 75 文件 / 57 令牌 / 756 引用，退出码 0 |
| 生产构建 | `npm run build` | 成功，10.42s；仅有 chunk >1200kB 提示 |

### 3.2 后端

| 检查 | 结果 |
|---|---|
| `mvn -DskipTests compile` / `package` | 成功 |
| `SchedulePeriodCheck` | `passed: boundaries, legacy edits, duplicate periods, stopped-doctor maintenance and restore` |

### 3.3 F5 三套结构

| 结构 | 关键日志 | 结果 |
|---|---|---|
| 当前结构 | `PASS 当前结构：active_phone 已存在，跳过迁移` | `BUSINESS RULES INTEGRATION PASSED`，退出码 0 |
| 迁移前结构 | `PASS 迁移前结构：已执行 active_phone 迁移` | `BUSINESS RULES INTEGRATION PASSED`，退出码 0 |
| 异常结构（列在、索引缺） | `STRUCTURE ERROR: 缺少唯一索引 uk_active_phone` | 退出码 1 |

两套正常结构日志中的 `ERROR 1062 Duplicate entry` 是脚本故意写入重复手机号触发的唯一约束，紧随其后的 `PASS 11` 即该断言通过。

### 3.4 F1—F3 回归（`tools/audit_regression.mjs`）

| 场景 | 关键证据 |
|---|---|
| F1 CHAT 广播 | `NO_BUSINESS_FRAMES ... closed:true`；`closeCode:1008`；重连 401 |
| F1 REST 结束会话 | SESSION 帧被拦截；连接关闭；会话 `status=2` |
| F1 恢复消息正文 | 0 业务帧；管理员审计仍读到正文 |
| F1 2 秒令牌过期 | 0 业务帧；连接关闭 |
| F2 会话处置 | 原连接收到 MODERATION；恢复正文 0 帧；连接未关闭；健康房间收发正常 |
| F2 重连对照 | 握手成功但进房 ERROR「问诊会话不存在」，无 HISTORY |
| F2 HISTORY 断言 | 首帧 HISTORY 单独留存；断言含可见消息、不含屏蔽消息，空数组不再恒真 |
| F3 关闭先取锁 | 关闭 200；发送 ERROR「问诊已结束，会话已关闭」；用户消息 0 条；摘要为结束提示 |
| F3 发送先取锁 | ACK 成功；消息顺序 用户消息 → 结束提示；摘要为结束提示 |
| F3 屏蔽旧消息 / 新消息定序 | 旧消息屏蔽成功，`lastMessage=AUDIT_HIDE_RACE_NEW`，`doctorUnread=1`；未清空摘要 |
| F3 写入后事务回滚 | 处置返回 500，会话仍为 `0/0`，无 MODERATION，连接未关闭，订阅仍可收消息 |
| F3 发送与已读 | `AGGREGATES_OK`；无死锁 |
| F3 发送与屏蔽 | `AGGREGATES_OK`；摘要指向最后可见消息 |
| F3 已读与屏蔽 | `AGGREGATES_OK` |
| 正常结束查看历史 | REST 历史 200；重新进房收到 HISTORY |

帧到达顺序与数据库提交结果分开记录：F3 关闭先取锁时观测到 `ERROR(seq=4)` 先于 `SESSION(seq=5)`，数据库状态仍为关闭成功、用户消息 0 条，符合"分别核验"的要求。

### 3.5 预约对照重放

`appointments.mjs` 全部通过：重复下单 4 请求 1 成功、最后号源 3 请求 1 成功、重复支付状态稳定、并发取消 1 成功且号源仅退 1、并发病历同一 ID 且有效病历 1 份、并发评价 1 条、跨账号/跨医生权限全部拒绝、非参与方 WebSocket 订阅/发送/已读均拒绝且消息数 0。

## 4. 回归脚本

新增 `tools/audit_regression.mjs`，运行方式：

```powershell
node tools/audit_regression.mjs <runtime.json>
```

`runtime.json` 字段沿用现有隔离配置：

```json
{"db":"pet_clinic_test_xxxxxxxx","api":"http://127.0.0.1:8082/api","mysqlDefaultsFile":"...\\mysql-client.cnf"}
```

同目录需有 `jwt-secret.txt` 与 `actors.json`。脚本启动时校验库名格式、`SELECT DATABASE(),@@port`、`SHOW GRANTS` 与后端地址；日志写入同目录 `audit-regression.jsonl`，不记录令牌与密码。本轮创建的宠物、会话、消息按精确 ID 清理，账号状态与医生在线状态恢复原值。

`room()` 会把首帧 HISTORY 另存到 `conn.history`，因为 `take()` 会把它从帧队列移除；F2 直接检查该对象中的消息内容，避免 `[].every(...)` 恒真。

## 5. 环境清理

- 后端 8082、MySQL 3307 均已停止，无 LISTENING。
- 数据库已恢复运行前快照，恢复后 dump 与恢复前逐字节一致：
  - `sha256 = 53dfe8bd584ee79b70ec88f04a3d50b3c1079fec82995f6fe8ab33ce029766ab`
- 清理后行数与基线一致：`pet=10`、`consult_session=3`、`consult_message=17`；测试误建的科室 0 条。
- 本轮测试数据全部删除，未保留临时业务记录。

## 6. 说明与限制

1. **写入后回滚验证**：用 `consult_message` 的 CHECK 约束只拦截本会话的处置系统消息，使处置的会话更新成功、随后插入系统消息失败，整个事务回滚。断言会话仍为 `status=0 / moderate_status=0`、无 MODERATION、连接未关闭、原订阅仍可收消息，约束在 `finally` 删除。该夹具不需要 SUPER 权限，也不影响其他会话。
2. **帧顺序**：F3 只断言提交结果、消息落库顺序、摘要与未读一致性；网络帧到达顺序单独记录，不作为通过条件。原因是 `afterCommit` 与 WebSocket 写线程存在调度竞争。
3. **前端构建环境**：本机 esbuild 0.21.5 在含中文的仓库路径下启动时报 `winmm.dll not found`（Go 运行时早期 DLL 搜索问题）。验证时将同一二进制复制到 ASCII 临时路径并通过 `ESBUILD_BINARY_PATH` 指向它，构建成功后已删除临时副本；仓库文件未为此改动。
4. **提交**：按要求未执行 `git commit` / `git push`，工作区保留四组可独立审查的差异。
