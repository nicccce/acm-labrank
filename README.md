# ACM 实验室榜单

基于[项目设计](docs/项目设计.md)的 pnpm workspace 脚手架。当前已打通 Next.js Web、独立 worker、PostgreSQL / Drizzle 迁移、pg-boss 队列、注册登录和首位管理员引导。平台采集、积分榜、队伍及外站登录按 P1—P3 实施，页面明确显示尚未接入。

## 快速启动

本机已完成初始化并启动，可访问 <http://localhost:3000>。管理员用户名见 `.env`，初始密码保存在 `.secrets/admin-bootstrap-password`，不写入文档、日志或镜像。

新环境需要 Docker Desktop 的 Linux 引擎、Compose，以及用于生成本地配置的 Node.js 22 或更高版本。应用实际运行在镜像固定的 Node.js 24.21.0 中：

```powershell
node scripts/setup.mjs
docker compose up -d --build
docker compose ps
```

`setup` 生成随机数据库密码和两个 Secret 文件，重复执行保留现有配置。正式使用时配置 `APP_URL` 为 HTTPS 地址；默认仅发布 `127.0.0.1:3000`，数据库不发布宿主端口。用户名为 3—32 位字母、数字或下划线，统一转小写；密码 12—128 位。

当前主机的 Docker 外网拉取失败，已通过宿主机下载并校验官方镜像、临时转发官方 npm 注册表完成首次构建。镜像已缓存在本机，可直接运行 `docker compose up -d --no-build`。后续重建需恢复 Docker 网络，或指定可达的可信 npm 源：

```powershell
docker build --build-arg NPM_REGISTRY=https://你的可信npm源/ -t acm-leaderboard:local .
docker compose up -d --no-build
```

环境实测、验证范围及本机网络限制见[环境检测记录](docs/环境检测.md)。

## 结构与依赖

```text
apps/
  web/src/
    app/                     页面与 Route Handlers
    components/              客户端交互
    lib/http.ts              HTTP 校验、Cookie、错误响应
  worker/src/                队列消费、心跳、退出处理
packages/
  core/src/
    domain/                  浏览器可用的纯规则
    application/             服务端用例、配置、认证与引导
  db/
    src/                     schema、查询、数据库与队列连接
    drizzle/                 版本化 SQL 迁移
  connectors/src/
    contracts/               平台无关类型
    codeforces/ qoj/ luogu/   后续适配器与解析样本
    metadata.ts registry.ts  纯元信息与服务端显式注册
scripts/                     初始化、环境检测与运行验证
```

依赖方向：`apps → core/application → db、connectors`。领域规则不访问环境、数据库或网络，连接器不写库或决定本站归属。业务服务直接使用 db helpers，不为每张表增加 repository/service。共享包没有混合根入口，客户端只导入 `@acm/core/domain`、`@acm/connectors/contracts` 或 `metadata`；服务端入口设置浏览器导入屏障，ESLint 检查关键依赖边界。

当前有认证/运行表 `users`、`sessions`、`auth_rate_limits`、`runtime_heartbeats`，以及读取入口使用的共享 `platform_request_limits` 和通用加密 `connector_sessions`；另有 Drizzle 迁移记录及 pg-boss 队列 schema。平台账号、提交、业务同步游标和队伍表尚未建立。

## 本地开发

本地开发使用 [.node-version](.node-version) 指定的 Node.js 24.21.0 和 `packageManager` 指定的 pnpm 11.19.0。系统 Node.js 22 可生成配置，但不满足应用开发工具链要求。

```powershell
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm setup
docker compose -f compose.yaml -f compose.dev.yaml up -d db
pnpm db:migrate
pnpm admin:bootstrap
pnpm dev
```

开发数据库仅在 `127.0.0.1:5433` 发布，`.env` 的默认 `DATABASE_URL` 与之对应。若已有 Docker Web 占用 3000，先执行 `docker compose stop web worker`，再启动本地进程。修改数据库凭据时同时更新连接串，特殊字符需要 URL 编码。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm doctor` | 检查 Node、Docker 引擎、Compose、配置与锁文件 |
| `pnpm check` | TypeScript、ESLint、单元测试 |
| `pnpm build` | 生产 Web 构建 |
| `pnpm db:generate` | 根据 schema 生成 SQL 迁移，检查后提交 SQL 和 meta |
| `pnpm db:migrate` | 迁移业务表、升级队列 schema 并创建队列 |
| `pnpm admin:bootstrap` | 仅在不存在管理员时创建；存在则跳过且不读取密码 |
| `pnpm queue:probe` | 真实数据库下验证队列去重、事务回滚与 worker 消费 |
| `pnpm verify:smoke` | HTTP 验证；会在配置数据库中创建临时 member 账号 |

Docker 运行验证：

```powershell
docker compose exec worker pnpm queue:probe
docker compose logs --tail=100 web worker migrate bootstrap
```

`queue:probe` 通过 `exclusive + singletonKey` 验证未完成任务去重，并验证事务回滚不留下任务。探针仅用于基础队列验证；账号级 `requestSync`、业务游标和调度器尚待 P1 实现。

## 启动与认证约定

所有应用服务使用同一多阶段镜像，运行身份为非 root。Compose 按 `db healthy → migrate 成功 → bootstrap 成功 → web / worker` 启动。业务迁移有独占锁，管理员引导有事务锁；web / worker 的 pg-boss 使用 `migrate: false`，不在启动时迁移结构。

| 入口 | 行为 |
| --- | --- |
| `GET /api/health/live` | 进程存活 |
| `GET /api/health/ready` | 数据库、业务迁移数量和队列 schema 版本匹配 |
| `POST /api/auth/register` | 注册 member 并建立会话 |
| `POST /api/auth/login` | 登录并返回用户 DTO 与 CSRF token |
| `GET /api/auth/session` | 查询当前会话 |
| `POST /api/auth/logout` | 校验 Origin 和 X-CSRF-Token，撤销会话 |

所有写请求要求 `Origin` 与 `APP_URL` 相同；退出还要求 `X-CSRF-Token`。密码使用 Argon2id，随机会话 token 仅以 SHA-256 哈希入库；Cookie 为 HttpOnly / SameSite=Lax，HTTPS 时 Secure。认证接口使用数据库限流，支持跨进程共享；错误返回 `{code, message, requestId, retryAt?}`。用户 DTO 不包含密码哈希。普通页面和会话响应不进入公共缓存。

`SYNC_ENABLED` 为未来同步调度保留。常驻 worker 仍消费系统探针并维护心跳；独立读取命令可经 application 调用平台连接器，使用 PostgreSQL 共享请求配额。自动同步调度和业务入库尚未接通，平台未连接不影响 Web 就绪。

## 扩展步骤

- 新用例：放入 `core/application`，HTTP 层只校验权限、输入并调用用例；服务器组件直接复用用例。
- 新数据：修改 `db/src/schema.ts`，执行 `pnpm db:generate`，审查迁移；更新 `health.ts` 的业务迁移数量后部署。
- 新平台：实现读取/登录适配器与去标识化样本，在服务端 registry 显式注册，更新纯元信息和契约中的平台 ID。未实现的适配器抛出 `NOT_IMPLEMENTED`。
- 新积分规则：在 `core/domain` 添加带版本的纯函数、配置和边界测试；不从客户端读取数据库。
- 更新 pg-boss：一起检查版本、迁移和 `EXPECTED_QUEUE_SCHEMA`，重新运行队列探针。平台任务的并发、游标与请求租约按项目设计实现。

停止可使用 `docker compose down`，命名卷保留数据库。更新、备份和恢复的产品目标见项目设计；完整榜单及同步调度仍按阶段实施。各平台最新接口实现与实际验证状态以平台 README 为准。

## QOJ 个人原始提交入口

运行与维护见 [QOJ 采集流程与技术维护](docs/QOJ采集流程与技术维护.md)，包括当前浏览器复用、人工登录、正式队列、回填增量、升级和故障处理。

已实现个人账号解析、全状态提交 HTML 解析、分页与版本化游标。正式 Worker 的 `platform.qoj.read` 队列和调试命令共用应用处理器；配置 `QOJ_TRANSPORT=browser` 可启用专用有界面 Edge/Chromium。Docker CDP 模式复用常驻浏览器当前登录状态，不自动导入数据库 Cookie；独立启动浏览器的模式仍保留原有加密恢复逻辑：

```powershell
pnpm db:migrate
pnpm qoj:debug --browser --target muhammad --connection qoj-lab --pages 2 --state .local/qoj-backfill.json --http-diagnostics
# 正式 Worker 使用环境中的 QOJ_TRANSPORT；另一个终端投递只读任务
pnpm qoj:debug --enqueue --target muhammad --pages 2
```

Docker 服务器使用可选 `compose.qoj-browser.yaml`，由 Worker 容器内的 Chromium + Xvfb 执行导航；管理员通过 noVNC 远程操作同一个浏览器。宿主机无需 pnpm：

```powershell
node scripts/setup.mjs
docker compose -f compose.yaml -f compose.qoj-browser.yaml build worker
docker compose -f compose.yaml -f compose.qoj-browser.yaml up -d
docker compose -f compose.yaml -f compose.qoj-browser.yaml exec worker pnpm qoj:debug --enqueue --target muhammad --pages 2
```

noVNC 默认为 `http://127.0.0.1:6080/vnc.html`；远程部署通过 SSH 隧道访问，使用本地受保护的 `.secrets/qoj-vnc-password`。具体人工确认、tmpfs/加密会话和实测边界见 [QOJ Docker 说明](packages/connectors/src/qoj/README.md#docker-浏览器与生命周期)。

2026-10-02 17:29—17:42（北京时间），正式 Worker 经真实 PostgreSQL 队列完成 muhammad 的41页可见历史：406条唯一提交、59个题目，第41页HTTP 200，history_end/historyComplete=true；真实checkpoint增量在两页后checkpoint_reached。可选 `QOJ_BROWSER_MANUAL_START=true` 让容器先打开正常登录页，管理员登录后用 `pnpm qoj:confirm --attach --id 当前事件UUID` 确认一次性接管；Worker 随后核验登录身份并重新请求目标。CDP只监听容器回环，QOJ以常驻浏览器会话为准，新脚本不自动导入密文Cookie；退出仅断开连接，保留容器Chromium。当前浏览器未重启，用户已取消密文恢复验证。

镜像内完整 `pnpm check`（123 项测试）和生产构建通过；真实挑战任务取消、截图清理、未接管时的预算到期和 CDP/CLI 退出已验证。本机 Docker 直连出网失败，实测使用受限 TLS CONNECT 诊断代理，生产服务器不应依赖该临时脚本。Cloudflare 对受控浏览器可能再次拒绝，延迟接管不能保证通过；真实全量、会话恢复及最终统计以[QOJ README](packages/connectors/src/qoj/README.md)为准。远程桌面尚未嵌入本站管理员界面。
