# QOJ 个人原始提交

操作手册见 [QOJ 采集流程与技术维护](../../../../docs/QOJ采集流程与技术维护.md)；本文保留连接器规则与真实验收证据。

2026-10-02 17:29—17:42（Asia/Shanghai），正式 Worker 已完成 muhammad **41 页可见历史、406 条唯一提交、59 个题目**，末页 HTTP 200，history_end/historyComplete=true；真实 checkpoint 的增量读取在两页后 checkpoint_reached。完整记录及核对结果见本文末尾。

## 请求链路与边界

`apps/worker/src/index.ts → createQojReadWorker.execute → collectQojSubmissionPages/readAccount → qojConnector → RequestContext.request → PostgreSQL 请求租约 → page.goto`。

调试 CLI 与正式 `platform.qoj.read` 队列使用同一处理器。连接器只负责 URL、账号、HTML 与标准记录。浏览器 GET 读取主文档原始 `response.body()`，保留状态、最终 URL、必要响应头与 observedAt；正常脚本重载时取真正最终主文档。没有 Node refetch、DOM 伪造 200、stealth、指纹修改或验证码破解。

公共入口提供默认 3000 ms 间隔、独占租约、30000 ms 硬超时、4 MiB 限制、Retry-After、取消和最多 2 次网络/超时/429/5xx 重试。账号、身份、分页、重叠页和恢复请求均走该入口；脚本及 Cloudflare 子资源由浏览器正常加载，不逐个领取应用配额。总批次预算覆盖任务锁等待和人工接管，失败页不推进 cursor/checkpoint。

队列 output 保存去重标准提交、题目与进度，日志只输出统计和脱敏响应元数据。pg-boss completed 仅表示处理器返回，必须检查 output.status/historyComplete。业务事实表、同步游标、绑定版本校验、自动调度和 Web 榜单仍未接通。

## Docker 浏览器与生命周期

`worker-browser` 目标包含 Debian Chromium、Xvfb、Openbox、x11vnc、websockify/noVNC。`scripts/qoj-container.mjs` 持有常驻 Chromium，Worker 以 `connectOverCDP` 接管默认 context。CDP 仅监听容器内 `127.0.0.1:9222`，不发布宿主端口。Worker.close 关闭自己创建的采集页并断开 CDP；**不能关闭外部默认 context**，否则会终止持久浏览器。容器退出才结束 Chromium 和桌面进程。默认 runtime 镜像不包含浏览器。

```powershell
node scripts/setup.mjs
docker compose -f compose.yaml -f compose.qoj-browser.yaml build worker
docker compose -f compose.yaml -f compose.qoj-browser.yaml up -d
docker compose -f compose.yaml -f compose.qoj-browser.yaml exec worker pnpm qoj:debug --enqueue --target muhammad --pages 2 --duration-ms 300000
docker compose -f compose.yaml -f compose.qoj-browser.yaml logs --tail=30 worker
```

[noVNC 入口](http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale)，VNC 密码在宿主 `.secrets/qoj-vnc-password`，本地读取后手动输入，不放入 URL、argv、日志或任务。6080 只发布宿主回环，5900 仅监听容器回环，关闭跨端剪贴板。八字符 VNC 认证不能保护公网端口；远程服务器使用受控 SSH 隧道，例如 `ssh -L 6080:127.0.0.1:6080 管理员@服务器`。尚未嵌入本站管理页或实现管理员鉴权代理。

容器为 node/UID 1000，无 privileged、host IPC 或日常浏览器目录挂载，cap_drop=ALL、shm_size=1gb。专用 profile 在 tmpfs 的 `/tmp/qoj-browser/profile`；`/tmp`、`/app/.local`、`/app/apps/worker/.local` 重建时丢失。tmpfs 不等于加密，服务器须保护 swap、VM 快照与 Secret：[Docker tmpfs 限制](https://docs.docker.com/engine/storage/tmpfs/)。使用 --no-sandbox，不能宣称 Chromium 内部 sandbox 已加固。管理员只应在人工处理期间操作；noVNC 尚未按任务状态锁定输入。

## 先人工登录，再接管

此前受控 Edge/Chromium及已接管容器 Chromium 曾持续 CF 循环，不能仅据此确定唯一原因。可选 `QOJ_BROWSER_MANUAL_START=true` 先直接打开目标主页，**Worker 在确认前不连接 CDP**。17:23 起真实观察到正常 QOJ 登录页，用户登录并反馈来到主页后，Worker 接管、核验身份并成功采集两页；这只证明本次路径可用。

```powershell
$env:QOJ_BROWSER_MANUAL_START='true'
$env:QOJ_BROWSER_START_TARGET='muhammad'
docker compose -f compose.yaml -f compose.qoj-browser.yaml up -d --no-deps --no-build worker
docker compose -f compose.yaml -f compose.qoj-browser.yaml logs --tail=10 worker

# 在 noVNC 完成实际登录后，填写本次 manual_start 事件 UUID。
docker compose -f compose.yaml -f compose.qoj-browser.yaml exec worker pnpm qoj:confirm --attach --id 当前事件UUID
docker compose -f compose.yaml -f compose.qoj-browser.yaml exec worker pnpm qoj:debug --enqueue --target muhammad --pages 2 --duration-ms 300000
```

本地握手 `/app/.local/qoj-browser-attach.json` 位于受限 tmpfs，只含 id/confirmed/expiresAt，10 分钟有效。CLI 拒绝旧 UUID、重复和过期确认；Worker 消费后删除。取消等待保留有效事件供新任务续用；过期须重新启动专用容器，不复用旧确认。等待不占 HTTP 租约，仍受任务锁、取消和总预算约束。

确认只允许接管。Worker 保留刚完成人工登录的 Cookie，重新请求 `/` 并用 verifySession 核验采集身份，再重新导航目标 profile 和提交 URL。可配置 QOJ_LOGIN_HANDLE 要求指定账号。**按用户要求，QOJ CDP 模式以常驻浏览器会话为准，新脚本不读取数据库 Cookie 快照、不清空浏览器 Cookie。**浏览器保持运行期间，脚本退出只断开连接；容器/profile 丢失或登录失效时由管理员重新登录，不将密文恢复作为该模式的运行前提。成功响应的加密写回仍保留，独立启动浏览器/Node 模式沿用原有恢复逻辑。直接调试 CDP 只在正式 Worker 空闲时运行，禁止多进程同时操作同一默认 context；任务锁仅在单 Worker 进程内。

[Cloudflare 支持环境](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)明确不支持 Playwright 等框架解决生产挑战。远程桌面和延迟接管不能保证通过；再次持续循环时停止点击，考虑站点侧允许采集账号/IP、官方接口或导出。浏览器扩展/页面内导出若另行实现，需要管理员显式触发、限时授权和受控加密传输，Worker 验证目标与分页并标明浏览器提供数据的信任边界；当前未实现或验收此替代能力。

## 会话和人工恢复

`${connectionId}:browser` 槽保存 AES-256-GCM 密文 QOJ Cookie，nonce/tag 和 AAD 绑定平台/连接/版本，密钥来自 SESSION_ENCRYPTION_KEY_FILE。仅恢复 Cookie，不导出明文 storageState，不恢复 localStorage/IndexedDB/sessionStorage，不覆盖 UA。浏览器升级、网络变化或会话失效仍可能要求重新登录；Node jar 用独立槽。保存必须持请求租约且未取消，失败登录/挑战不覆盖旧会话。

密码、Cookie、验证码不能进入 argv、任务、日志、状态 JSON、源码或 fixture。完整 connection generation/revocation 管理 API、自动 POST 登录和 2FA 尚未真实验收。

cf-mitigated: challenge 和明确挑战 title/DOM（包括 HTTP 200）分类为 cloudflare；正常 challenge-platform 脚本本身不是挑战。登录页/跳转为 login，权限页为 restricted，结构异常为 parse_changed，不能当空提交或 history_end。

默认人工等待 120000 ms、最多 2 次；headless/没有渠道时返回 human_input_required。本次接管使用 QOJ_HUMAN_RETRIES=0 避免重复已知循环。TTY 用 Enter，非 TTY 用 `pnpm qoj:confirm --id 当前挑战UUID`（不加 --attach）；之后必须再核验身份并请求原 URL。旧确认无效，晚确认不复活取消任务；截图短时保存，结束/取消/超时删除。人工等待不持 HTTP 租约，但持任务锁。

## 字段、分页与完整性

入口是 `/user/profile/muhammad` 和 `/submissions?submitter=muhammad`。主页无时间 Accepted problems 只核对缺口，不制造原始提交/首次 AC。仅个人，不采队伍/VP或源代码。

真实页面每页 10 条，第二页为 &page=2；只带 submitter/page，不加状态、分数、语言或比赛过滤，同时校验最终 URL、筛选框、逐行作者和 active 页码。分页窗口不是总页数，越界可能钳制末页；只有正常表头、正确 active 页以及 next disabled 且无 href 才 history_end，异常空页必须失败。

提交/题目 ID 保持字符串，原站链接为 /submission/{id} 和 /problem/{id}，难度 null。包含所有状态，保留 nativeResult/nativeScore；100 分本身不当 AC，明确 Accepted/✓ 才 accepted。记录保存 qoj-html-1/observedAt，返回前 Zod 校验。错作者、错筛选、钳制页码、非法时间和结构变化失败。

时间来自 time datetime 的显式时区，页脚 Server Time UTC+8 辅助核对，存 UTC。两页真实样本：3073094 / 题目197 / Compile Error，`2026-10-01T18:12:21+08:00` → `2026-10-01T10:12:21.000Z`。主页通过题没有时间，不生成提交。

cursor/checkpoint v1 绑定账号、模式和 parser；每页边界重读前一页、按 ID 去重。未完回填不生成新 checkpoint，增量跨锚点后再读完整一页才 checkpoint_reached。超过一页的漂移须另跑顶部增量；backfill 与 incremental 用独立状态。

## 调试与实测

本机没有全局 pnpm；本轮命令在 Node 24.21.0 Docker 镜像中执行。调试仍支持 --browser-channel、--browser-executable、--browser-proxy、--browser-cdp、--headless、--memory（不跨进程保存会话），以及独立的 state/checkpoint JSON（只含目标、模式和进度）。

```powershell
pnpm qoj:debug --browser --target muhammad --pages 2 --state .local/qoj-backfill.json --http-diagnostics
pnpm qoj:debug --browser --target muhammad --mode incremental --checkpoint .local/qoj-checkpoint.json --state .local/qoj-incremental.json --pages 3
pnpm qoj:debug --enqueue --target muhammad --pages 2 --duration-ms 300000
pnpm qoj:cancel-probe
pnpm check
pnpm build
```

代理仅接受 HTTP/HTTPS/SOCKS5 endpoint，拒绝用户名、密码、路径、查询和 fragment。本机 Docker Desktop 直连出网失败，诊断使用 .local/qoj-connect-proxy.mjs 的受限 TLS CONNECT，不解密流量；构建临时转发官方 Debian/npm 源，apt 校验签名，pnpm 校验锁文件。生产正常服务器直连或使用批准的代理，不依赖本机脚本。

已实测：旧 job dcb4039a-e4c4-4b0c-988a-381d6160dd05 取消后返回 CANCELLED、pages=0，采集页/截图和租约释放；未接管预算探针 948a085c-b69d-4094-a031-5818839d2aae 返回 timeout/TIMEOUT、pages=0、cursor/checkpoint=null，人工登录页/事件保留。一次性 CDP probe 断开后 browserAlive=true，独立 qoj:debug 超时后自行退出，桌面容器退出0。代码镜像内 pnpm check 通过 **123 项**，TypeScript 与 pnpm build 通过。

fixture 覆盖恢复、错身份、会话失效、锁等待、超时/取消、晚确认、挑战上限、分页/筛选/时区/结构变化；这些不代替真实验收。用户明确取消密文 Cookie 恢复验证，当前浏览器与登录状态保留；真实会话失效后重登尚未实测。

## 本轮真实结果

| 正式 job | 结果 |
| --- | --- |
| 7fb69455-5e54-47d3-af40-2b57c23b32ae | 第1—2页，20条唯一提交，3个题目，more，cursor.page=3，checkpoint=null。 |
| fb4734bc-1f01-45c6-8387-6a5abf2e6eed | 从第3页续读39页到第41页，396条（含重叠的第2页），history_end，cursor=null，checkpoint.headId=3073094。 |
| 1d8d9d05-f72b-438b-9704-760391b0fd8a | 使用真实 checkpoint 读两页，20条唯一提交，checkpoint_reached，cursor=null，historyComplete=false。 |

两批回填合并时去掉10条重叠，最终406条、59题：accepted 58、rejected 12、unknown 336。原生分数保留；仅分数不能推断完整 verdict。最早2200887 / 题目1994 / 100 ✓ / 2026-04-06T09:06:56.000Z；最新3073094 / 题目197 / Compile Error / 2026-10-01T10:12:21.000Z。第二页首条3071217 / 题目196 / 47分 / 2026-10-01T07:09:54.000Z。

所有行内作者均为 muhammad，ID、题目 ID、UTC 时间、来源链接和 null 难度已逐条核对。随后独立抽查通过真实 RequestContext 验证采集身份 youth_fed_cpp；目标主页显示46个 Accepted problems，与58条AC提交去重得到的46个题目ID完全一致，只作缺口对照、不生成提交。末页真实 active=41，next disabled 且无 href，含6行，time 显式+08:00；最老一行2026-04-06T17:06:56+08:00与标准UTC相符。historyComplete表示该登录身份当前可见历史结束，不承诺不可见记录或站点永久可用。

标准化证据（不含原始HTML/Cookie/storageState）保存在本机 .local/qoj-visible-history.json，checkpoint 在 .local/qoj-checkpoint.json；.local 被 git/dockerignore 排除，正式输出仍可按上述 job ID 从 PostgreSQL 读取。业务事实表和自动调度尚未实现。

17:51保持当前容器/Chromium不重启，以禁用CDP数据库Cookie导入的新脚本再次读两页：20条唯一提交、HTTP 200、status=completed、cursor.page=3；CLI正常退出，浏览器保留。源码和新镜像已更新；为保留登录现场，未重建当前运行容器。新镜像代码摘要0106f8948bc7，运行容器启动时镜像4af9c9fe9bc7；新脚本使用已同步的qoj-browser.ts。正式常驻Worker进程的已加载模块未热替换。

本轮修改文件：packages/core/src/application/qoj-browser.ts、qoj-worker.ts、config.ts；新增qoj-browser-attach.ts及其测试；apps/worker/src/index.ts、qoj-debug.ts；scripts/qoj-container.mjs、qoj-confirm.ts；compose.qoj-browser.yaml、.env.example、根README和本文。其余原有dirty修改均保留。
