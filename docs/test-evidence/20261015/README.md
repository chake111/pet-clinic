# 业务测试证据（2026-10-15）

本目录是 2026-10-15 业务测试的过程证据归档，由 `.tmp/qa-20261015` 原样移入。下午追加轮证据在 `followup/`。

## 结果文件

| 文件 | 内容 |
| --- | --- |
| `business-before.txt` | 第一轮接口与 WebSocket 场景运行记录（13 组场景） |
| `recheck.txt` | 重复占号、停用账号、完整预约链路复测结果 |
| `races.txt` | 取消与接诊竞争、缩容与下单竞争各 10 轮结果 |
| `upload-before.json` / `upload-after.json` | 图片校验修复前后的上传用例响应 |
| `final-database.txt` | 完整流程后的数据库终态核对 |
| `final-browser.log` | 完整流程的浏览器执行输出 |

## 复测脚本

`recheck.mjs`、`races.mjs`、`lifecycle.mjs`、`review-upload-auth.mjs`、`business-extended.mjs`、`permissions-regression.mjs`。

脚本从仓库根目录运行，读取 `qa_env.py` 生成的 `runtime.json` 所记录的隔离环境（MySQL 3307、后端 8082、前端 5174）。

## 敏感信息检查

- 令牌：全部证据与脚本均无 JWT 令牌。
- 密码：仅隔离库种子账号的演示密码 `123456`。
- 追加轮最终三角色截图为 `followup/164041-qaowner.png`、`164041-qadoctor.png`、`164041-qaadmin.png`；`followup/frontend-copy-build.txt` 为前端文案精简后的生产构建输出。