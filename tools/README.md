# tools

隔离测试环境与业务回归脚本。它们不是生产入口，也不会在 CI 中执行；CI 只跑 `backend` 的单元测试与 `frontend` 的 lint / test / build。

## 前置条件

- Node.js 22、Python 3、MySQL 客户端
- `main_flow_browser.mjs` 另需 Playwright（可用 `PLAYWRIGHT_PACKAGE` 指向已安装的包）
- 先由 `qa_env.py prepare` 生成隔离库与 `runtime.json`；后续脚本都用 `--config` 或 `PETQA_CONFIG` 指向它

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `qa_env.py` | 隔离测试环境的 prepare / check / instance / start / stop；建库、建受限账号、导入 schema 与种子数据 |
| `business_qa.py` | 隔离演示库的快照 / 恢复与查询辅助 |
| `acceptance.mjs` | 真实链路验收：登录改密与令牌失效、重连已读语义、科室行锁 |
| `business_rules_check.mjs` | 业务规则回归；运行前用 `business_qa.py snapshot` 备份 |
| `audit_regression.mjs` | 审计修复后的回归入口，覆盖宠物、会话、消息与账号状态 |
| `main_flow_check.mjs` | 主流程接口级回归，运行在专用测试库 |
| `main_flow_browser.mjs` | 主流程真实浏览器验收，输出截图与执行日志 |
| `read_receipt_check.mjs` | 已读回执回归：进房/重连不写已读，仅显式 READ 归零 |
| `schedule_status_check.mjs` | 排班状态回归：状态只由停诊/恢复写入 |
| `dashboard_query_check.mjs` | 看板聚合口径与索引命中回归 |
| `trace_id_check.mjs` | 500 追踪号回归：响应体、响应头与日志可对应 |
| `gen_data_model.py` | 从 `sql/01_schema.sql` 生成 `docs/数据模型.md` |
| `prepare_business_demo.py` | 准备一份可重复的浏览器演示数据 |

## 压测脚本

| 脚本 | 用途 |
| --- | --- |
| `load/run-load.sh` | 100 VU race/oversell 并发正确性压测，独立 compose 项目 `yuzhuaload`；`EVIDENCE_DIR` 可覆盖 |
| `load/run-steady.sh` | 默认 30 req/s × 3 分钟稳态读混合压测，带 Prometheus/Grafana（`observability` profile），独立项目 `yuzhuaperf` |

两个脚本都会为隔离栈提供测试专用 MySQL/JWT 默认值，并处理 Windows Git Bash 的路径转换；`KEEP=1` 保留栈供检查或截图。说明见 [`docs/test-evidence/20261116-observability/README.md`](../docs/test-evidence/20261116-observability/README.md)。

## 注意

`qa_env.py` 会建库、建账号并导入结构；`01_schema.sql` 自带 `DROP DATABASE yuzhua`，脚本会先改写成隔离库名并校验，避免误连本机业务库。执行前请确认 `--admin-defaults-file` 指向的是测试实例。