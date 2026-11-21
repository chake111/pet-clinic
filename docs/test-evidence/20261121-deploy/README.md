# 2026-11-21 生产部署证据

## 运行总览

`runs.txt` 记录 `gh run list --workflow deploy.yml` 截至归档时的 8 次运行（4 次失败，4 次成功；所有 secrets 在 GitHub Actions 日志中均已自动打码）。

## 4 次失败原因与修复方式对照表

| Run ID | 时间 (UTC) | 触发方式 | 报错摘要（见 `failures.txt`） | 原因 | 修复方式 |
| --- | --- | --- | --- | --- | --- |
| `44871613018` | `2026-11-21T05:35:45Z` | `push` | `usage: ssh ...` / `exit code 255` | 日志直接显示 `SSH_HOST` 与 `SSH_USER` 展开为空（其余 4 项已配置为 `***`；当初漏填原因未另行记录） | 补齐 `production` environment 的必填 secrets |
| `44873053843` | `2026-11-21T05:54:45Z` | `workflow_dispatch` | `Host key verification failed.` / `exit code 255` | `SSH_KNOWN_HOSTS` 与目标服务器公钥指纹不匹配 | 使用 `ssh-keyscan -H <host>` 重新生成并更新 `SSH_KNOWN_HOSTS` |
| `44873481195` | `2026-11-21T06:00:32Z` | `workflow_dispatch` | `bash: line 1: cd: ***: Not a directory` / `exit code 1` | `DEPLOY_PATH` 填成了 `compose.yaml` 的文件路径 | 将 `DEPLOY_PATH` 改为 `compose.yaml` 所在的目录路径 |
| `44875227449` | `2026-11-21T06:22:19Z` | `workflow_dispatch` | `bash: line 1: cd: ***: Not a directory` / `exit code 1` | 同上（`DEPLOY_PATH` 仍为文件路径） | 修正 `DEPLOY_PATH` 为目录路径后，于 `44876361951` 首次部署成功 |

## 归档文件清单

- `runs.txt`：`gh run list --workflow deploy.yml` 原始输出（8 次运行）
- `run-44876361951.log`：首次成功部署（`44876361951`）的完整日志
- `failures.txt`：4 次失败各自的报错行摘录
- `smoke.txt`：线上 `/api/actuator/health`、`/api/actuator/health/readiness`、`/healthz`、`/demo` 响应记录
