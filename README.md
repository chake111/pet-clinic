# 宠物医院预约问诊系统

[![CI](https://github.com/chake111/pet-clinic/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chake111/pet-clinic/actions/workflows/ci.yml)

单家宠物医院自用的预约 + 在线图文问诊系统。宠物主人在手机上找医生、挂号、付款、发起免费图文问诊、拿病历和评价；医生在后台接诊、写病历，还能在会话里一键建议患者到院挂号；管理员管科室、医生、排班、公告和全院数据。

前后端分离：Vue 3 单工程承载用户端与后台，Spring Boot 3 提供 REST + WebSocket 接口，MySQL 存全部业务数据。

## 功能范围

**用户端**（未登录可浏览医生，下单前才要求登录）

- 账号注册 / 登录，资料与密码维护
- 宠物档案：多只宠物，种类、品种、体重、绝育与过敏史
- 找医生：按科室、关键词筛选，按综合 / 评分 / 接诊量排序
- 医生详情：擅长领域、简介、未来 7~30 天号源、患者评价（含医生回复）
- 挂号下单：选宠物、选时段、填病情描述、最多 6 张症状图
- 模拟支付：点一下即支付；30 分钟未支付由定时任务取消并退回号源
- 图文问诊：从医生主页直接发起，选宠物 + 描述症状即建会话——免费、不限次、不占号源、不走支付
- 问诊会话：WebSocket 实时消息，文字 + 图片，已送达 / 已读回执，医生在线状态；患部照片点开看大图，可左右翻阅整场会话的历史图
- 到院建议：医生在会话里一键发「建议到院」卡片，患者点卡片直达该医生的挂号页
- 问诊小结：医生结束问诊时留一段书面结论（线上只建议、确诊要面诊），展示在患者会话顶部
- 电子病历：主诉、体格检查、诊断、处方、处置、医嘱、复诊日期、检查影像
- 就诊评价：三维评分 + 文字 + 图片，可匿名；医生回复公开展示
- 我的预约 / 病历 / 会话列表，未读消息角标

**后台**（管理员与医生共用一套界面，按角色裁剪菜单）

- 医生：我的会话（接诊、建议到院、写问诊小结）、接诊工作台（接诊 + 写病历 + 结束就诊同屏）、我接诊的工单与病历、我的排班、评价回复
- 管理员：看板统计、全部工单、用户账号与宠物档案、排班号源（单条与按周批量）、医生管理、科室管理、公告科普、病历查询、评价显隐治理、问诊记录只读追溯

**两端共用**

- 图片查看器：聊天患部照片、病情描述附图、检查影像、评价附图、公告封面都能点开大图，支持滚轮缩放与旋转；同一组图整体进查看器，左右键翻阅，顶部标注这张图的来源（谁在什么时间发的），图取不到时给明确说明而不是裂图

## 界面预览

配图来自运行中的前后端，展示演示账号的实际页面。

**用户端**（窄屏 430 宽）

| 找医生 | 选号下单 | 图文问诊 | 我的病历 |
| --- | --- | --- | --- |
| <img src="docs/screenshots/04-client-doctors.png" width="190" alt="找医生"> | <img src="docs/screenshots/06-client-booking.png" width="190" alt="选号下单"> | <img src="docs/screenshots/10-client-consultroom.png" width="190" alt="图文问诊"> | <img src="docs/screenshots/11-client-records.png" width="190" alt="我的病历"> |

**管理后台**（1440 宽）

| 工作台看板 | 排班号源 | 医生管理 | 接诊工作台 |
| --- | --- | --- | --- |
| <img src="docs/screenshots/21-admin-dashboard.png" width="300" alt="工作台看板"> | <img src="docs/screenshots/23-admin-schedule.png" width="300" alt="排班号源"> | <img src="docs/screenshots/24-admin-doctors.png" width="300" alt="医生管理"> | <img src="docs/screenshots/31-doctor-workbench.png" width="300" alt="接诊工作台"> |

**基础数据维护**（1440 宽，第二批补齐的后台页面）

| 用户管理 | 宠物管理 | 问诊记录 |
| --- | --- | --- |
| <img src="docs/screenshots/28-admin-users.png" width="300" alt="用户管理"> | <img src="docs/screenshots/29-admin-pets.png" width="300" alt="宠物管理"> | <img src="docs/screenshots/33-admin-consult-records.png" width="300" alt="问诊记录"> |

完整截图在 `docs/screenshots/`，按用户端、后台与医生端编号命名：用户端的登录注册、首页、医生详情、发起图文问诊、宠物档案、我的预约、线上支付、就诊评价、问诊会话与聊天页；后台的登录、工单、排班、医生、用户、宠物、病历、评价、问诊记录、公告；以及医生视角的会话列表、聊天页、我的排班与结束问诊（小结）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 Vite 5.4 Element Plus 2.8+ Pinia 2 Vue Router 4 Axios 1.7 ECharts 5.5 |
| 后端 | Spring Boot 3.5.16 JDK 17 MyBatis-Plus 3.5.17 原生 WebSocket jjwt 0.12.6 |
| 接口文档 | springdoc-openapi 2.8 + Swagger UI（OpenAPI 3） |
| 数据 | MySQL 8（库名 `pet_clinic`，12 张表，逻辑外键，逻辑删除） |
| 认证 | JWT（HMAC-SHA，jjwt 按密钥长度自动选 HS256/384/512；7 天）+ `HandlerInterceptor` 路径前缀鉴权 + `@RequireRole`；密码 BCrypt |

号源防超卖靠一条带条件的 UPDATE 实现。

## 持续集成

每次 push 到 `main` 或向 `main` 提交 PR，GitHub Actions 会执行：

- 后端：JDK 17 + `mvn --batch-mode --no-transfer-progress verify`（单元测试 + 集成测试 + 打包，见[测试与并发证据](#测试与并发证据)）
- 前端：Node.js 22 + `npm ci`、`npm run lint`、`npm test`、`npm run build`
- 部署：Docker Compose 构建并启动 MySQL、后端、nginx，校验健康接口与种子数据（仅 PR）

工作流见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 与 [`.github/workflows/docker.yml`](.github/workflows/docker.yml)，action 版本由 Dependabot 每周检查。Dependabot 的英文 PR 标题由 `Localize Dependabot PR` 工作流自动改成中文。

## 测试与并发证据

### 单元测试

```bash
cd backend && mvn --batch-mode --no-transfer-progress test
```

现有 130 个用例，覆盖 JWT 密钥与令牌版本、账号状态校验、状态取值、排班周期校验、批量查询、WebSocket 会话注册表，以及预约与排班两个核心服务的状态机分支。只跑 surefire，不需要 Docker。

### 集成测试

```bash
cd backend && mvn --batch-mode --no-transfer-progress verify
```

需要 Docker Desktop 已启动（`docker info` 有输出）：Testcontainers 拉起临时 MySQL，覆盖下单、支付幂等、取消退号、超时释放、取消与清扫竞态，以及 100 线程抢 20 个号源。`*IT` 由 maven-failsafe-plugin 在 `verify` 阶段执行，`test` 阶段不会跑。

CI 的 backend job 已经执行 `mvn verify`，接入 failsafe 后这些集成测试随流水线自动运行，不需要改 workflow。

### 压测

```bash
bash tools/load/run-load.sh
```

脚本用独立 compose 项目 `petclinicload` 起一套隔离环境，不占用本机 3306 端口。两个场景：

| 场景 | 号源 | 并发 |
| --- | --- | --- |
| race | 100 个 | 100 VU 同抢 |
| oversell | 20 个 | 100 VU 同抢 |

`run-load.sh` 串起 `fixture.sql` 造数据、`booking-race.js` 施压、`verify.sql` 核对库内终态。成功与拒绝按响应体 `code` 判定，不按 HTTP 状态。

### 实跑结果

- `mvn verify`（2026-11-16，本机）：130 个单元测试 + 7 个集成测试全部通过，`BUILD SUCCESS`，约 1 分钟；完整输出见 [`docs/test-evidence/20261116-it-load/mvn-verify.txt`](docs/test-evidence/20261116-it-load/mvn-verify.txt)。
- 覆盖率门禁：后端 `mvn verify` 中 JaCoCo 对 `AppointmentService` / `DoctorScheduleService` 行覆盖 ≥95%（当前均 100%）；前端 `npm run test:coverage` 对 `tools/style-guard/index.mjs` 与 `src/utils/tableDensity.js` 行/分支/函数 ≥95%。
- k6 race / oversell 尚未跑，结果待补，证据文件见同目录。

<!-- LOAD_RESULTS_START -->
<!-- 由验证方在 k6 实跑后填入：race success/p95、oversell success/rejected、verify.sql verdict -->
<!-- LOAD_RESULTS_END -->

隔离环境下的接口与浏览器验收脚本见 [tools/README.md](tools/README.md)，过程证据在 [docs/test-evidence/](docs/test-evidence/)。提交信息另由 commitlint 校验 Conventional Commits（仅 PR），冒号后的描述必须包含中文，规则见 [commitlint.config.cjs](commitlint.config.cjs)。

## Docker 一键启动（演示环境）

要求 Docker Desktop 已启动（`docker info` 有输出）。在仓库根目录执行；首次构建会下载 Maven 与 npm 依赖，时间取决于网络。

```bash
cp .env.example .env          # 填入 PETCLINIC_MYSQL_ROOT_PASSWORD、PETCLINIC_DB_PASSWORD、PETCLINIC_JWT_SECRET
docker compose up -d --build --wait --wait-timeout 300
docker compose ps             # 三个服务 healthy 后打开 http://127.0.0.1:8088
```

Compose 起三个服务：MySQL 8.4 LTS、Spring Boot 后端、nginx + Vue 构建产物。数据库不发布到宿主机；首次启动自动执行 `sql/01_schema.sql` 和 `sql/02_data.sql`，导入 12 张表、12 位医生和 24 张演示图。

- 用户端：http://127.0.0.1:8088/
- 后台：http://127.0.0.1:8088/admin/login
- Swagger：http://127.0.0.1:8088/api/swagger-ui/index.html
- 停止并保留数据：`docker compose down`
- 停止并清空数据库与上传图片：`docker compose down -v`
- 改代码后重建：`docker compose up -d --build --wait`
- 看日志：`docker compose logs -f backend`（或 `db`、`web`）

`.env` 含口令与 JWT 密钥，已被 `.gitignore` 忽略，不要提交。JWT 密钥可用 `openssl rand -base64 48` 生成，长度至少 32 字节。这套 compose 面向本机演示；生产部署仍看 [docs/部署步骤.md](docs/部署步骤.md) 第 7 节。

## 快速开始

```bash
# 1. 建库导数据。01_schema.sql 自带 DROP/CREATE DATABASE，不要预先手建
mysql -uroot -p < sql/01_schema.sql
mysql -uroot -p pet_clinic < sql/02_data.sql

# 2. 后端（8081，上下文 /api）。JWT 密钥没有默认值，未设置会启动失败
export JWT_SECRET='dev-only-please-use-a-random-32-byte-secret'
cd backend && mvn spring-boot:run

# 3. 前端（5173，代理 /api 到 8081）
cd frontend && npm install && npm run dev
```

打开 http://127.0.0.1:5173 即可。完整的前置条件、端口冲突处理、生产构建与目录约定见 [docs/部署步骤.md](docs/部署步骤.md)。

## 演示账号

种子数据里的密码统一是 `123456`，登录页有点击填充的快捷按钮。

| 入口 | 账号 | 身份 | 说明 |
| --- | --- | --- | --- |
| `/` | `zhangsan` | 患者 | 有预约、病历和进行中的问诊会话 |
| `/` | `lisi` | 患者 | 新用户，适合演示注册到下单全流程 |
| `/admin/login` | `admin` | 管理员 | 全院菜单与数据 |
| `/admin/login` | `doctor01` | 医生（陈明远） | 有当日排班 |
| `/admin/login` | `doctor11` | 医生（刘恋） | 有进行中 / 待接诊 / 已结束的图文会话，和一张待接诊的到院单 |

`service01` 是第二个管理员（前台客服），`zhouba` 是禁用账号示例，用于演示账号状态校验。

## 目录结构

```
├── sql/            01_schema.sql 建表 + 02_data.sql 种子数据（脱敏但贴近真实）+ migrations/ 增量迁移
├── backend/        Spring Boot 服务
│   └── src/main/java/com/petclinic/
│       ├── common/     Result / PageResult / BizException / 全局异常处理
│       ├── config/     MVC、拦截器、MyBatis-Plus、Jackson、OpenAPI、WebSocket、配置属性
│       ├── security/   JWT 工具、AuthInterceptor、WsHandshakeInterceptor、AccountGuard
│       ├── controller/ client/（用户端） admin/（后台） common/（上传）
│       ├── service/    业务层（预约、排班、问诊、病历、评价、统计）
│       ├── entity/ mapper/ dto/ vo/
│       ├── websocket/  会话注册表与图文消息处理器
│       └── task/       超时未支付订单清扫
├── frontend/       Vue 3 单工程
│   └── src/
│       ├── api/      按端拆分的接口封装 + 唯一 axios 实例
│       ├── assets/   logo 与吉祥物图等静态资源
│       ├── layouts/  ClientLayout（窄栏 + 底部 tab）/ AdminLayout（侧边菜单）
│       ├── router/   路由表（用户端与后台两套入口）
│       ├── views/    client/（用户端页面） admin/（后台与医生端页面）
│       ├── components/ ConsultPanel、ImageGallery、ImageViewerHost、ImageUpload、DeptIcon、MedicalRecordSheet、PaymentTicket、LoadFailure、LoginScene、LoginForm、ChangePasswordForm、DoctorCard、PetForm、PetPicker、StatusChip
│       ├── stores/   登录态与账号信息
│       ├── styles/   全局样式与变量
│       └── utils/    枚举文案、时间金额格式化、token、WebSocket 客户端、图片查看器状态、列表滚动、病历与排班展示、科室图标素材
├── docs/           设计约定 / 接口文档 / 数据模型 / 部署步骤 / ADR / 架构图 / 界面截图 / 测试证据
├── tools/          隔离测试环境与验收脚本（qa_env / acceptance / business_rules_check / main_flow_* / read_receipt / schedule_status / dashboard_query / trace_id）
└── .github/        CI 工作流与 Dependabot
```

## 文档

- [文档索引](docs/README.md)：所有文档的入口
- [接口文档](docs/接口文档.md)：统一响应结构、鉴权约定、按端分组的接口清单、WebSocket 帧协议
- [数据模型说明](docs/数据模型.md)：表职责、逻辑外键、关键字段与索引设计，由 `tools/gen_data_model.py` 从 `sql/01_schema.sql` 生成
- [部署步骤](docs/部署步骤.md)：环境要求、建库、启动、生产构建、常见问题
- [架构决策记录](docs/adr/)：关键取舍的裁定与理由（问诊与预约解耦、"未到诊"终态、陈氏 ER 等）
- [设计约定](docs/design.md)：用户端布局、色彩与组件规则
- [技术亮点改造记录](docs/技术亮点改造记录-20261114.md)：四个缺陷的根因、动作与验证

## 已知边界

- 支付是模拟的：只把 `pay_status` 置为已支付，取消时标记退款，不调用任何支付渠道。
- 图片存在后端进程的 `uploads/` 本地目录并以静态资源暴露，不接对象存储；换机器部署需要自己迁移该目录。
- 医生账号由管理员在数据库/后台维护，没有自助入驻与资质审核流程。
- 会话消息只有文字、图片和到院建议卡片，没有视频、语音与文件。
- 站内消息中心、疫苗提醒、医生独立工作台未纳入本次范围。
- Swagger UI 与 OpenAPI 描述（`/api/swagger-ui.html`、`/api/v3/api-docs`）免登录公开，方便联调与演示；上公网前应在网关屏蔽或以 `springdoc.api-docs.enabled=false` 关闭。
- CORS 与 WebSocket 握手允许任意来源（`WebMvcConfig` / `WebSocketConfig`，为开发期 Vite 直连后端所需，鉴权仍强制 token）；登录无速率限制。这两条假设生产环境由 nginx 同源转发兜住，直接暴露公网前需在网关层收敛。
