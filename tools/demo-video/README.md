# 演示视频可再生制作流水线（`tools/demo-video/`）

本目录沉淀演示视频与 B 站发布封面的端到端自动化制作链路，严格遵循仓库根目录 [AGENTS.md](../../AGENTS.md) 的三条规矩：

- **规矩一（品牌单源）**：所有脚本、分镜与合成模板均不硬编码品牌名，统一从 `frontend/src/brand.js` 动态读取并注入 `{{brand.*}}` 占位符。
- **规矩二（一条命令可再生）**：由 `node tools/demo-video/build.mjs` 一键串联环境校验、上传卷种子图同步、幂等数据准备、Playwright 录屏与断言、FFmpeg 预处理、HyperFrames 离线合成、成片校验与 B 站封面生成；所有录屏、中间产物与成片统一写入 `output/demo-video/<YYYY-MM-DD>/`（已在 `.gitignore` 忽略，不入库），入库派生封面 `docs/demo-video/cover.png` 由 `--stage=cover` 或全量构建一键再生，禁止手改。
- **规矩三（不变量与门禁前置）**：数据准备幂等守恒、录制零 `pageerror`/`console.error`/账号密码泄露、`hyperframes check --json` 零错误门禁、`ffprobe` 硬指标复核（`1920×1080`、`30fps`、`≤ 60s`、`yuv420p`、`+faststart`、纯静音单视频轨）、80% 标题安全区与封面 4:3 裁切安全区真实 DOM 包围盒校验。

## 1. 目录结构与分工

| 路径 | 职责 |
| --- | --- |
| `prepare.sql` | 幂等演示数据准备（确认主角启用、清理主角残留会话与当日/未来预约、重建近 14 天多科室 `DEMO-HIST-*` 看板历史单、确保当日三班有余号并校验号源守恒） |
| `storyboard.json` | 8 镜头 58 秒分镜规范（角色路由、交互选择器、断言文案、宠主口吻 ≤14 字故事字幕与功能标签、80%/90% 安全区、DPR 2 视口配置、禁用敏感词清单） |
| `record.mjs` | Playwright 双端协同录屏脚本（`--force-device-scale-factor=2`、`recordVideo.size = 2×`、`Asia/Shanghai` 时区、数字打板器帧级校准、只读净化 `/demo` 落地页、产出 `raw/*.webm` 与 `timeline.json`） |
| `compose/` | HyperFrames 纯离线合成与校验模块（`tokens.css`、`render-plan.mjs`、`ffmpeg-prep.mjs`、`generate-project.mjs`、`contact-sheet.mjs`、`p4-verify.mjs`、`render-cover.mjs` 及 `templates/`） |
| `build.mjs` | 流水线总入口，默认注入 `HYPERFRAMES_NO_TELEMETRY=1` 与 `DO_NOT_TRACK=1` |

## 2. 前置条件与环境说明

1. **本地业务栈（Docker Compose）**：
   ```bash
   docker compose up -d --wait
   ```
   确认 `db`、`backend`、`web` 均 `healthy`，且 `http://127.0.0.1:8088/healthz` 返回 `200`。
2. **工具链**：
   - **Node.js 22+**、**FFmpeg / FFprobe**（在 `PATH` 中）；
   - **Playwright**（支持 `PLAYWRIGHT_PACKAGE` 指向全局安装，默认浏览器通道 `msedge`，自动回退 `chromium`）；
   - **HyperFrames CLI 启动器**：默认读取 `~/.agents/skills/hyperframes/scripts/plugin-cli.mjs`（可用 `HYPERFRAMES_PLUGIN_CLI` 覆盖），使用本地缓存 `chrome-headless-shell` 与 `gsap@3.15.0`，全程纯离线渲染，无需登录、无需额度、关闭遥测（`HYPERFRAMES_NO_TELEMETRY=1`）。
3. **中文字体（`YUZHUA_FONT_PATH`）**：
   - 默认读取 Windows 预装 `C:\Windows\Fonts\NotoSansSC-VF.ttf`（Noto Sans SC v2.04，SIL Open Font License 1.1，支持 100–900 变量字重）；
   - 跨平台可通过环境变量 `YUZHUA_FONT_PATH` 指定本地 TTF/OTF 字体；构建时仅拷贝至 `output/` 下的临时渲染工程，不将字体大文件提交入库。
4. **当天挂号时间窗（北京时间 `21:30` 前）**：
   - 医生接诊工作台默认过滤「当天」预约，因此镜头 5 实录挂当天未结束时段的号（末班为 `18:00–21:30`）。
   - **正式执行 `record.mjs` 录屏须在北京时间 `21:30` 前进行**；超过 `21:30` 时 `record.mjs` 会显式报错拦截，防止拍出时段已过期的失败单。复用已有录屏运行 `--skip-record` 不受时间窗限制。

## 3. 一键复现与分阶段命令

```bash
# 1. 全链路静态预检（校验品牌单源、分镜预算/字幕字数、字体与工具链，不改库、不启浏览器）
node tools/demo-video/build.mjs --dry-run

# 2. 一条命令端到端全量再生（种子图同步 → prepare.sql → 录屏 → 合成检查 → 1080p/360p 成片 → 自动验收 → B 站封面）
node tools/demo-video/build.mjs

# 3. 复用已有录屏：仅生成分镜头关键帧拼图（验收 1 阶段，不渲染 mp4）
node tools/demo-video/build.mjs --skip-record --stage=keyframes --date 2026-11-21

# 4. 复用已有录屏：离线渲染 1080p 成片 + 360p 预览 + P4 全项自动校验 + B 站封面
node tools/demo-video/build.mjs --skip-record --stage=render --date 2026-11-21

# 5. 仅对已渲染成片复跑 P4 自动验收（ffprobe / faststart / 80% 标题安全区 DOM 校验 / 解码抽帧）
node tools/demo-video/build.mjs --stage=verify --date 2026-11-21

# 6. 一条命令单独再生 B 站封面 docs/demo-video/cover.png 与 4:3 裁切预览
node tools/demo-video/build.mjs --skip-record --stage=cover --date 2026-11-21
```

### 产物目录（`output/demo-video/<YYYY-MM-DD>/`，已在 `.gitignore` 忽略，不入库）

- `raw/*.webm`：Playwright 原始 DPR 2 录屏（5 路）。
- `timeline.json`：v1 时间轴协议（原始 WebM 第 0 帧基准、打板器校准、66 条事件坐标、`gaps[]` 与 `syncPairs[]`）。
- `render-plan.json`：经空档裁切、双路对齐与倍速规划后的确定性合成计划。
- `hf-project/`：物化的纯离线 HyperFrames 工程。
- `hyperframes-check.json`：`hyperframes check --json` 门禁报告。
- `keyframes/`：首帧 `frame-00-first.png`、逐镜头关键帧、4×2 主拼图 `contact-sheet.png`、4×4 明细拼图 `contact-sheet-detail.png`、640×360 预览拼图 `preview-640x360.png`。
- `yuzhua-demo-60s.mp4`：最终 `1920×1080 @ 30fps` H.264 `yuv420p` `+faststart` 纯静音成片。
- `yuzhua-demo-360p.mp4`：同步导出的 `640×360` 预览成片。
- `p4-check.json` / `decoded-1080p/` / `decoded-360p/`：P4 自动验收报告与从最终成片直接解码的帧拼图。
- `cover-4x3-preview.png` / `cover-small-preview.png` / `cover-check.json`：B 站封面居中 `1440×1080`（4:3）裁切预览、信息流小图预览与 4:3 安全区包围盒校验报告。

---

## 4. B 站发布物料草稿（可直接复制使用）

### 标题

```text
60 秒看完：宠物医院预约 + 在线问诊，已上线可试用｜个人项目
```

### 简介

```text
单家宠物医院的预约挂号与在线图文问诊全栈项目：宠主按症状找医生、发起实时图文问诊（WebSocket 已读回执）、收到医生到院建议卡一键转挂号支付；医生端实时接诊并归档门诊电子病历；管理端查看全院经营看板。

在线试用（免注册，宠主 / 医生 / 管理三端直接进入）：
https://yuzhua-petclinic.top/demo

技术栈：Vue 3 + Pinia + Element Plus / Spring Boot 3 + JDK 17 + MyBatis-Plus / MySQL 8 / WebSocket / Docker Compose

GitHub 源码与完整文档：
https://github.com/chake111/yuzhua-pet-clinic
```

### 标签

```text
宠物医院, 在线问诊, 预约挂号, Vue3, SpringBoot, 个人项目, 实习作品集
```

### 分区

```text
科技 · 计算机技术
```

### 封面

- 路径：[docs/demo-video/cover.png](../../docs/demo-video/cover.png)
- 规格：`1920×1080`（16:9 PNG），全部核心文字、插画与真机画面均严格收束在居中 `1440×1080`（`x ∈ [240, 1680]`）4:3 裁切安全区内，兼顾 16:9 详情页与 4:3 推荐流裁切展示。
- 再生命令：`node tools/demo-video/build.mjs --skip-record --stage=cover --date 2026-11-21`
