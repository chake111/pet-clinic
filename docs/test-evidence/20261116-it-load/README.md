# 集成测试与压测证据（2026-11-16）

本目录保存 2026-11-16 这一轮 `mvn verify` 集成测试与 k6 压测的过程证据，供论文与答辩引用。本文只说明文件用途与引用规则，不预设结论；数值以目录内文件为准，根 README 只引用实测值。

## 预期文件

| 文件 | 内容 | 产生方式 |
| --- | --- | --- |
| `env.txt` | 执行环境：操作系统、JDK、Maven、Docker、k6 版本与 MySQL 镜像标签 | 实跑前记录 |
| `mvn-verify.txt` | `mvn --batch-mode --no-transfer-progress verify` 完整输出，含 failsafe 执行的 `*IT` 用例与结果 | `cd backend && mvn --batch-mode --no-transfer-progress verify` |
| `fixture.log` | `fixture.sql` 导入结果；成功后写入一行夹具规模标记 | `bash tools/load/run-load.sh` |
| `race.log` | race 场景（100 个号源 / 100 VU）的 k6 控制台输出 | `bash tools/load/run-load.sh` |
| `oversell.log` | oversell 场景（20 个号源 / 100 VU）的 k6 控制台输出 | `bash tools/load/run-load.sh` |
| `summary-race.json` | race 场景的 k6 汇总，含成功数、拒绝数与 `http_req_duration` p95 | `run-load.sh` 导出 |
| `summary-oversell.json` | oversell 场景的 k6 汇总，含成功数、拒绝数与 p95 | `run-load.sh` 导出 |
| `verify.log` | `verify.sql` 的查询输出：两条排班的余量、订单数、排队号与 PASS/FAIL | 压测结束后连 `petclinicload` 库执行 |

清单之外的文件不作为本轮证据；上表文件缺失即视为对应步骤未执行，不用口头数字或其他轮次的日志代替。

## 引用规则

- 数值以 `summary-race.json`、`summary-oversell.json`、`verify.log` 为准；`race.log`、`oversell.log` 用于对照，不作为唯一来源。
- 根 README 的「实跑结果」只引用上述文件中的实测值；事后补写须与文件一致，不一致时以文件为准。
- 压测的成功与拒绝按响应体 `code` 统计（拒绝还要求 `msg` 含「号源已约满」），不按 HTTP 状态码。
- 集成测试用例数、通过数以 `mvn-verify.txt` 的 failsafe 汇总为准。

## 环境与复跑

- 集成测试需要 Docker Desktop，Testcontainers 使用临时 MySQL 容器，不依赖本机 3306。
- 压测使用独立 compose 项目 `petclinicload`，容器、网络和卷均与演示环境 `pet-clinic` 分开，不占用本机 3306 端口。
- 复跑命令与场景说明见根 README 的「[测试与并发证据](../../../README.md#测试与并发证据)」一节。