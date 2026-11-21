# 2026-11-21 演示视频成片复核证据

## 复核命令

```bash
node tools/demo-video/build.mjs --stage=verify --date 2026-11-21
```

## 对应提交与发布链接

- 工具链与封面提交：`93b2ad0ae55f725f92267f84be59a8fe3e92ae49`（`2026-11-21 03:57:37 -0500`，`feat(demo): 新增演示视频录制与合成工具链及封面`）
- 演示页接入视频链接提交：`3f02a3799a4a8d4e4b4549abc79192b016d2146f`（`2026-11-21 03:43:00 -0500`，`feat(demo): 演示页接入哔哩哔哩演示视频链接`）
- 哔哩哔哩链接：<https://www.bilibili.com/video/BV17tyazJEVD/>

## 成片与封面参数

数据来源：`p4-check.json`、`cover-check.json`（`.mp4` 文件本身不入库，两份 JSON 按仓库惯例原样归档）。

### 1080p 成片（`yuzhua-demo-60s.mp4`，未入库）

| 指标 | 值 |
| --- | --- |
| 时长 | `57.067s`（`57.066667s`，合成根时长 `57.061s`，差值 `0.006s`） |
| 分辨率 / 帧率 | `1920x1080` / `30/1fps` |
| 编码 / 像素格式 | `h264` / `yuv420p`（`streams=1`，`audio=false`） |
| `faststart` | `true`（`moovOffset=32`，`mdatOffset=8055`） |
| 80% 安全区检查 | 检查数 `25`，违规数 `0`（`ok=true`） |
| 文件大小 | `9,932,295` 字节（`9.47 MB`） |

### 360p 预览（`yuzhua-demo-360p.mp4`，未入库）

| 指标 | 值 |
| --- | --- |
| 时长 / 分辨率 / 帧率 | `57.067s` / `640x360` / `30/1fps` |
| 编码 / `faststart` | `h264` / `yuv420p`，`faststart=true`（`moovOffset=32`，`mdatOffset=21015`） |
| 文件大小 | `691,995` 字节（`0.66 MB`） |

### 封面校验（`cover-check.json`）

- 16:9 封面：`docs/demo-video/cover.png`（`1920x1080`，`310,608` 字节）
- 4:3 安全区检查：检查数 `11`，违规数 `0`（`ok=true`）

## 归档文件清单

- `p4-check.json`：运行 `--stage=verify` 生成的复核报告（`2026-11-21T09:23:57Z`）
- `cover-check.json`：封面尺寸与 4:3 安全区校验报告
- `contact-sheet-decoded-1080p.png`：1080p 成片解码帧拼图
- `contact-sheet-decoded-360p.png`：360p 预览解码帧拼图

## 边界说明

本次 `--stage=verify` 只对现有成片做参数、解帧与安全区复核。复核通过只能证明该份 `.mp4` 本身符合规格，不能证明 `03:57` 提交（`93b2ad0`）的脚本在当前环境下仍能重新生成完全一致的成片。`cover-check.json` 未在 `--stage=verify` 中重跑，沿用原生成时间 `2026-11-21T07:55:42Z`（早于 `93b2ad0` 提交约 1 小时）的校验输出。
