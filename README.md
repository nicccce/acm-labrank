# ACM 实验室榜单

pnpm workspace 项目，包含 Next.js Web、独立 worker、PostgreSQL / Drizzle 和 pg-boss。已实现统一注册登录、成员资料与三平台账号绑定、个人榜和明细页面，以及团队创建去重、成员管理和团队榜。团队按当前成员在整个查询区间内的个人成绩汇总。管理员可设置采集与计分平台、日期、定时周期和请求间隔，手动更新、局部重爬及管理平台登录；历史未完整时成绩标为暂定。独立比赛/VP、外站队伍绑定与组队提交纠正后续实施。

## 文档入口

- [文档索引](docs/README.md)：当前维护文档与历史记录。
- [个人后端与 Web 登录](docs/个人后端与Web登录.md)：本轮 API、管理员交接、采集开关和离线集成验证。
- [成员页面与团队榜](docs/成员页面与团队榜.md)：页面、团队计分、去重和接口。
- [管理员采集管理](docs/管理员采集管理.md)：管理页、定时增量、计分区间、平台选择和局部重爬。
- [采集架构与管理 API](docs/采集架构与管理API.md)：公共契约、数据库限流、连接状态、错误处理与部署。
- [QOJ 运行手册](docs/QOJ采集流程与技术维护.md)：专用浏览器、人工登录、接管与故障处理。
- 连接器规则：[Codeforces](packages/connectors/src/codeforces/README.md)、[洛谷](packages/connectors/src/luogu/README.md)、[QOJ](packages/connectors/src/qoj/README.md)。

## Docker 启动

需要 Docker 的 Linux 引擎、Compose 和 Node.js 22+（仅配置生成）；应用镜像固定 Node.js 24.21.0。

```powershell
node scripts/setup.mjs
docker compose up -d --build
docker compose ps
```

默认访问 <http://localhost:3000>。管理员用户名在本地 `.env`，初始密码在受保护的 `.secrets/admin-bootstrap-password`。初始化重复运行保留既有配置；已有管理员时引导跳过。正式部署把 `APP_URL` 配为实际 HTTPS 地址。

本地登录测试使用 `docker compose -f compose.yaml -f compose.qoj-browser.yaml up -d --build`。打开 <http://localhost:3000/admin/collection>，默认仅启用 CF，初次迁移暂停采集、关闭自动同步；确认成员绑定后即可启用。需要 QOJ/洛谷时先在 <http://localhost:3000/admin/connections> 登录/核验，再加入采集。`docker compose run --rm --no-deps seed` 创建测试成员及待验证候选；测试密码见 `.secrets/member-test-password`。

默认仅发布宿主回环 Web 端口，数据库不发布。QOJ 专用浏览器使用可选 `compose.qoj-browser.yaml`，启动与人工登录见运行手册。网络受限时可向构建传入 `NPM_REGISTRY` 指向可信 HTTPS npm 源；本机历史排障不作为新环境启动前提。

## 结构与依赖

```text
apps/
  web/src/
    app/                         页面和 HTTP Route Handlers
    components/                  客户端交互
    lib/http.ts                  权限、输入与错误响应
  worker/src/
    runtime/                     队列、心跳、维护与退出
    cli/                         平台读取及人工输入命令
packages/
  core/src/
    domain/                      浏览器可用的纯规则
    application/
      collection/                公共读取、队列与管理用例
      platforms/                 平台会话、浏览器及登录
  db/
    src/collection/              采集 SQL helpers
    src/schema.ts                表定义
    drizzle/                     版本化迁移
  connectors/src/
    contracts/                   平台无关类型
    codeforces/ qoj/ luogu/       平台请求、解析与样本
scripts/                         配置、部署及验证工具
docs/                            当前文档，archive/ 为历史记录
```

依赖方向为 `apps → core/application → db、connectors`。连接器不写库，领域规则不访问数据库或网络。客户端仅导入 `@acm/core/domain`、`@acm/connectors/contracts` 或 `metadata`；服务端使用共享包公开入口，ESLint 检查依赖边界。

当前表包含认证、共享配额、加密会话与登录尝试、平台身份/绑定、题目/提交/归属、同步游标/运行，以及队伍、成员关系历史和团队操作记录。原有读取运行仍保存诊断摘要；正式个人同步按页事务保存事实及业务游标。

## 本地开发与检查

使用 [.node-version](.node-version) 中的 Node.js 24.21.0，以及 pnpm 11.19.0。

```powershell
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm setup
docker compose -f compose.yaml -f compose.dev.yaml up -d db
pnpm db:migrate
pnpm admin:bootstrap
pnpm dev
```

开发数据库仅在宿主 `127.0.0.1:5433` 发布。如果 Docker Web 已占用 3000，先停止 Web/worker 再启动本地进程；QOJ 浏览器 worker 停止可能丢失当前会话，应先保存所需进度。

| 命令 | 用途 |
| --- | --- |
| `pnpm doctor` | 检查 Node、Docker、配置与锁文件 |
| `pnpm check` | TypeScript、ESLint、单元测试 |
| `pnpm build` | 生产 Web 构建 |
| `pnpm db:generate` | 生成迁移，审查后提交 SQL 和 meta |
| `pnpm db:migrate` | 业务迁移、队列 schema 与策略初始化 |
| `pnpm queue:probe` | 真实数据库下的基础队列验证 |
| `pnpm collection:probe` | 独立测试库下的采集集成验证；限制见采集文档 |
| `pnpm personal:verify` | 独立测试库验证个人事实、登录、配置、调度和局部重爬；`--http` 在含 Chromium 镜像额外验证 HTTP 和页面 |
| `pnpm members:seed` | 幂等创建测试成员及三平台候选，不重置已有密码 |
| `pnpm verify:smoke` | HTTP 验证，会创建临时 member |

## 平台读取

所有正式读取共用 `readPlatform`，输入目标统一为 `target`。CLI 保留旧的 `--handle`、`--account` 等参数别名；平台专用调试参数见各连接器说明。

```powershell
pnpm cf:read --target tourist --max-pages 2 --enqueue
pnpm luogu:read --target 863154 --max-pages 2 --enqueue
pnpm qoj:debug --target muhammad --pages 2 --enqueue
```

各平台配额由 PostgreSQL 共享，数据库策略支持调整间隔范围；环境间隔只在迁移时初始化缺失策略。失败运行可从管理 API 查询、重试；洛谷/QOJ 重新核验连接后，worker 扫描并恢复待鉴权任务。

洛谷可在管理员 Web 页完成人工验证码登录，QOJ 通过页面内的专用浏览器/noVNC 登录。密码、验证码及 Cookie 不进入任务参数或运行摘要。QOJ CDP 模式沿用常驻浏览器会话，不自动导入数据库 Cookie。CLI 登录现仅核验身份并保存会话，不自动读取提交。

## 认证与部署

Compose 按 `db healthy → migrate 成功 → bootstrap 成功 → web / worker` 启动。应用非 root；web/worker 不在启动时迁移结构。就绪接口检查业务迁移及队列 schema 版本。

认证入口为 `/api/auth/register`、`login`、`session`、`logout`。写请求校验 Origin；退出及管理员写接口还校验 `X-CSRF-Token`。密码用 Argon2id，会话 token 仅以哈希入库，Cookie 使用 HttpOnly/SameSite=Lax；HTTPS 时 Secure。

发布包含新迁移的版本时，先备份并停止旧 worker，执行迁移，再部署匹配的新 Web/worker。QOJ 浏览器重建可能丢失登录状态，需准备人工重新鉴权。停止 Compose 默认保留数据库命名卷。当前源码是否已部署应由实际镜像和 readiness 确认，历史验收记录不代表运行环境自动更新。
