# 可观测性改造证据（2026-11-16 轮次）

本轮验证 Actuator 健康分组、Prometheus 指标出口、慢 SQL 日志和一次 3 分钟稳态读混合压测。
执行跨零点：目录名沿用计划里的 `20261116`，稳态压测与慢 SQL 验证实际在 2026-11-17 00:45–01:10 完成。

## 文件

| 文件 | 内容 | 产生方式 |
| --- | --- | --- |
| `env.txt` | 系统、CPU/内存、JDK/Maven、Docker、镜像 tag/digest、k6 版本 | 实跑前记录 |
| `mvn-verify.txt` | `mvn verify` 完整输出，154 单测 + 21 集成 | `mvn --batch-mode --no-transfer-progress verify` |
| `health.txt` | readiness/liveness 200；停库后 readiness 503、liveness 200；启库恢复；nginx 对 metrics/prometheus 返回 404 | `curl` + `docker compose ps` |
| `metrics-endpoint.json` | `/actuator/metrics/http.server.requests` 的 measurements 与 tags | 容器内 `curl` |
| `prometheus-sample.txt` | `http_server_requests_seconds_*` 样本，含 `_bucket` 与 `application`/`uri` 标签 | 容器内 `curl /actuator/prometheus` |
| `summary-steady.json` | k6 稳态压测汇总：QPS、p95、错误率、dropped | `tools/load/run-steady.sh` |
| `steady.log` | k6 控制台输出，首行是本轮 RATE/DURATION/PRE_VUS | `tools/load/run-steady.sh` |
| `grafana-steady.png` | Grafana 三格面板截图（1600×900） | 压测窗口内 Playwright 截取 |
| `prometheus-qps.json` | 压测窗口 `query_range` 的 QPS 序列，用于与 k6 交叉核对 | Prometheus HTTP API |
| `prometheus-targets.json` | Prometheus target 状态（`pet-clinic-backend:up`） | `curl /api/v1/targets` |
| `slow-sql.log` | 3 条 SELECT 慢 SQL，1470–1532ms，带 traceId | 行锁注入验证，见下文 |
| `race-slow-sql/` | 100 VU race/oversell 的日志、summary、verify 输出与行锁验证原始日志 | `run-load.sh`，`EVIDENCE_DIR` 覆盖 |

## 稳态压测数值

| 指标 | 实测 | 来源 |
| --- | --- | --- |
| QPS | 29.97 req/s | `summary-steady.json` → `http_reqs{phase:steady}.rate` |
| p95 | 5.55 ms | `summary-steady.json` → `http_req_duration{phase:steady}.p(95)` |
| HTTP 错误率 | 0% | `http_req_failed{phase:steady}` 无失败样本，k6 阈值通过 |
| 业务错误率 | 0 / 5401 | `business_error.count` / `http_reqs{phase:steady}.count` |
| dropped iterations | 0 | `summary-steady.json` → `dropped_iterations.count` |

- 30 req/s 是可重复负载，不是系统上限；本次数字不用于宣称最大吞吐。
- p95 是 k6 客户端端到端耗时；Grafana 的 p95 来自服务端 `http.server.requests` histogram，两者口径不同，不要求相等。
- 交叉核对：Prometheus 同一窗口（平台段 11 个采样点）平均 QPS 28.51，与 k6 的 29.97 相差 -4.86%，在 10% 以内。
- `http_req_failed{phase:steady}` 在没有失败样本时不会出现在 summary 的数值里；验收按「缺省或 0」都视为 0。
- `/actuator/metrics` 在 Boot 3.5 只返回 COUNT/TOTAL_TIME/MAX，不展示分位数；p95 以 Prometheus `histogram_quantile` 和 k6 summary 为准，因此只开了 `percentiles-histogram`，没有开 `percentiles`。

## 慢 SQL

阈值 200ms。日志只写 statement id、type、elapsed、failed，不写 SQL 文本和参数；traceId 由 `logging.pattern` 的 `%X{traceId:-}` 带出。

race 的 100 VU 抢同一排班行，客户端 p95 1.74s，但 Hikari 连接池只有 20 个连接，大部分等待发生在获取连接阶段（Executor 调用之外），单条语句没有达到 200ms，所以 race 本身没有产生慢 SQL 行。为了验证真实行锁等待，用 MySQL 事务持有 `doctor_schedule` 9001 行锁 2 秒，再发 3 笔真实下单：

```sql
START TRANSACTION;
SELECT id FROM doctor_schedule WHERE id = 9001 FOR UPDATE;
SELECT SLEEP(2);
COMMIT;
```

三笔下单都在锁上等待 1.47–1.53s 后成功，`slow-sql.log` 记录的是 `DoctorScheduleMapper.selectByIdForUpdate`（SELECT），不是造出来的文本。这是一次受控注入，数字只说明拦截器能记录行锁等待，不代表线上常态。

实现上有一个容易漏的点：MyBatis-Plus 的 `MybatisPlusInterceptor` 拦到 4 参 `Executor.query` 后，会用 6 参 `query` 调用内层 Executor。拦截器同时声明了两种 query 签名，否则 SELECT 不会进日志（`SlowSqlInterceptorTest` 对两条签名都有断言）。

## 引用规则

- QPS、p95、错误率以 `summary-steady.json` 为准；截图不作为数值来源。
- 慢 SQL 条数以 `slow-sql.log` 为准，阈值 200ms；行锁注入方式如上，引用时要带这个前提。
- 环境以 `env.txt` 为准；换机器复跑要新建日期目录，不覆盖本轮。
- 不引用其他轮次的数字，不对未实跑的配置写「预期值」。
- `summary-*.json` 已删除 k6 的 `setup_data`；`run-load.sh` / `run-steady.sh` 在复制汇总到证据目录时会自动过滤该字段，避免登录 token 进仓库。
- race/稳态压测都在独立 compose 项目里，演示栈 `pet-clinic` 的数据没有被压测写入。