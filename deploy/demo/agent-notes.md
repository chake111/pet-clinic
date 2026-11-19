# 愈爪在线演示落地页 · 首版稿说明

只做了一个方向，文件是 `deploy/demo/agent-draft.html`。样式和脚本都写在这一份里，图片在 `deploy/demo/agent-assets/`。没有改前端、后端、网关，也没有改 `deploy/demo/index.html`（仓库里没有这个文件）。

参考路径 `.oil-ui/demo-landing/index.html` 不在本仓库，稿子按 `docs/design.md` 和 `frontend/src/styles/main.css` 单独做，没有照着另一份落地页改。

## 设计方向

灰底白纸，三行标题。

- 页面底 `#f7f7f7`，内容是白卡片、1px 发丝线和 16px 圆角，跟用户端的中性面一致。
- 珊瑚 `#ff385c` 只出现在标志上。实心按钮用动作色 `#d92549`，白字对比度沿用设计约定里的 4.87:1。
- 第一屏标题就是三端：宠主挂号、问诊 / 医生接诊、写病历 / 管理员看全院。主按钮是「看 90 秒演示」，「进入宠主端」是二级，旁边写明首次加载较慢。
- 字体栈与 `main.css` 相同：Inter / Airbnb Cereal VF / PingFang SC / Microsoft YaHei。不引外部字体，也不引 CDN。
- 正文 16px、行高 1.7；说明和图注 15px、行高 1.7。按钮高 48px。

## 占位和后续要接上的

1. **B 站视频还是占位链接。** 页上两处「看 90 秒演示」都指向 `https://www.bilibili.com/video/BV1placeholder`。这不是一支真实视频。90 秒成片上传后，把这两处 `href` 换成真实 BV。页面正文没有写「占位」或「未接入」。
2. **一键登录的接收页还没做。** 三个入口已经按约定写成站根相对链接，接收页上线后可以沿用：
   - 宠主端 `/login?demo=user`
   - 医生端 `/admin/login?demo=doctor&redirect=/admin/my-schedule`
   - 管理端 `/admin/login?demo=admin&redirect=/admin/dashboard`
   页面写的是：若停在登录页，用页上的账号和密码。没有把自动登录说成已经完成。
3. **密码用的是公网演示约定 `Yuzhua@2026`。** 本地种子和 README 里的统一密码是 `123456`，不要把落地页改回种子密码。

## 素材从哪来、怎么裁

| 成品 | 来源 | 加工 |
| --- | --- | --- |
| `logo.svg` | `frontend/src/assets/logo.svg` | 原文件复制，728 字节 |
| `tuantuan.webp` | `frontend/src/assets/tuantuan-a-final.png`（1774×887，RGBA） | 等比缩到 680×340，保留透明，WebP quality 85 |
| `client-home.webp` | `docs/screenshots/03-client-home.png`（430×2184） | 裁顶部 `(0,0,430,860)`，不缩放，WebP quality 78 |
| `doctor-consult.webp` | `docs/screenshots/30-doctor-consult.png`（2096×458） | 裁左侧 `(0,0,1000,458)`，WebP quality 80 |
| `admin-dashboard.webp` | `docs/screenshots/21-admin-dashboard.png`（1440×1149） | 宽缩到 720，高按 1149×720/1440 = 574.5，四舍五入为 575，WebP quality 75 |
| `client-booking.webp` | `docs/screenshots/06-client-booking.png`（860×998） | 整张缩到宽 430（430×499），作预约海报 |
| `client-consult.webp` | `docs/screenshots/09-client-consult.png`（876×1808） | 先裁顶部 876×980（标题和两条会话，下面大段是空白），再缩到宽 438（438×490），作问诊海报 |

医生列表的右缘落在「会话状态」列中间，会切到半个「会」。文件仍是规定的 1000×458。页面上用 CSS 遮罩从 86% 淡到 94%，淡出发生在症状列和状态列之间的空档，症状正文留着，切掉的字不再露出来。

手机宽度装不下 1000 和 720 的整图。390 视口里这两张在卡片内部横向滚动（图宽 720），页面本身 `scrollWidth` 仍等于 390。图下有一句「左右滑动可以看清……」。桌面宽度不出现这句。

首屏主图是宠主首页，`fetchpriority="high"`。医生列表、管理看板、两张海报、团团都是 `loading="lazy"`。

## 图片体积

全部图片合计 **99218 字节（96.9 KB）**，低于 150 KB。

| 文件 | 体积 | 是否达标 |
| --- | --- | --- |
| `tuantuan.webp` | 18.1 KB | 吉祥物 ≤30 KB |
| `client-home.webp` | 26.4 KB | 三张截图各 ≤40 KB |
| `doctor-consult.webp` | 17.4 KB | 同上 |
| `admin-dashboard.webp` | 12.4 KB | 同上 |
| `client-booking.webp` | 12.0 KB | 计入 150 KB 总额 |
| `client-consult.webp` | 9.9 KB | 同上 |
| `logo.svg` | 0.7 KB | 同上 |
| 合计 | 96.9 KB | ≤150 KB |

## 落地页视口截图

用本机 headless Chrome 打开本地静态服务上的 `agent-draft.html`（`http://127.0.0.1:8765/agent-draft.html`），`deviceScaleFactor` 为 1，只截视口，不是整页长图。

| 文件 | 视口 |
| --- | --- |
| `deploy/demo/agent-shots/viewport-1440x900.png` | 1440×900 |
| `deploy/demo/agent-shots/viewport-390x844.png` | 390×844 |

两个视口都查过：`documentElement.scrollWidth === clientWidth`，没有横向溢出。标题各行的高度等于一行的 line-height。390 视口里逐字量过行框，没有只有一个汉字的行。按钮高度 48px。第一屏能看到三端、两个按钮、三个账号、密码，以及每日 04:00 重置和删除已禁用。
