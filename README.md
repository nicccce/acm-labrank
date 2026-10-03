# ACM 实验室榜单

pnpm workspace 项目，包含 Next.js Web、独立 worker、PostgreSQL / Drizzle 和 pg-boss。已实现统一注册登录、成员资料与三平台账号绑定、个人榜和明细页面，以及团队创建去重、成员管理和团队榜。团队按当前成员在整个查询区间内的个人成绩汇总。CF 组队提交按当场作者成员分别归属，题目积分除以实际队伍人数；每人同题只计首次 AC，计分规则为 v2。管理员可设置采集与计分平台、日期、定时周期和请求间隔，手动更新、局部重爬及管理平台登录；历史未完整时成绩标为暂定。独立比赛/VP、外站队伍绑定与组队提交纠正后续实施。

## 文档入口

本站队伍不设负责人，创建者和其他成员权限平等；每位当前成员都能增删成员、改名、归档和删除队伍。成员集合相同即为同一支队伍，成员顺序和队名不影响去重，已归档队伍也计入唯一性检查。

- [文档索引](docs/README.md)：当前维护文档与历史记录。
- [部署与运维](docs/部署与运维.md)：镜像部署、源码打包、QOJ 浏览器、备份、升级与故障排查。
- [个人后端与 Web 登录](docs/个人后端与Web登录.md)：本轮 API、管理员交接、采集开关和离线集成验证。
- [成员页面与团队榜](docs/成员页面与团队榜.md)：页面、团队计分、去重和接口。
- [管理员采集管理](docs/管理员采集管理.md)：管理页、定时增量、计分区间、平台选择和局部重爬。
- [采集架构与管理 API](docs/采集架构与管理API.md)：公共契约、数据库限流、连接状态、错误处理与部署。
- [QOJ 运行手册](docs/QOJ采集流程与技术维护.md)：专用浏览器、人工登录、接管与故障处理。
- 连接器规则：[Codeforces](packages/connectors/src/codeforces/README.md)、[洛谷](packages/connectors/src/luogu/README.md)、[QOJ](packages/connectors/src/qoj/README.md)。

## 部署方式一：Compose 直接拉取镜像

需要 Docker Linux 引擎和 Compose v2。镜像仓库为 [nicccce/acm-labrank](https://hub.docker.com/r/nicccce/acm-labrank)，当前版本 `2026.10.03`，发布平台为 `linux/amd64`。普通镜像包含 Web、worker、迁移及管理员初始化；`qoj-browser-2026.10.03` 额外包含 Chromium/noVNC。镜像内置 Node.js 24.21.0 和 pnpm 11.19.0，服务器无需安装 Node.js 或 pnpm。

Linux 服务器执行：

```bash
git clone https://github.com/nicccce/acm-labrank.git
cd acm-labrank
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/deployment" \
  --entrypoint node nicccce/acm-labrank:2026.10.03 \
  scripts/setup.mjs --directory /deployment
# 编辑 .env：本地测试保留 APP_URL；公网部署设为实际 HTTPS 地址
docker compose pull
docker compose up -d --wait
docker compose ps
```

Windows / Docker Desktop 可先用 Node.js 22+ 执行 `node scripts/setup.mjs`，然后执行同样的 `docker compose pull` 和 `docker compose up -d --wait`。初始化会生成随机凭据，重复运行保留已有配置。

默认访问 <http://localhost:3000>。管理员用户名见 `.env` 的 `ADMIN_BOOTSTRAP_USERNAME`，初始密码从 `.secrets/admin-bootstrap-password` 本地读取。正式部署通过反向代理提供 HTTPS，`APP_URL` 必须与浏览器访问地址一致；默认 Web 端口只绑定宿主 `127.0.0.1:3000`，数据库不向宿主发布。

需要 QOJ 时追加浏览器配置：

```bash
docker compose -f compose.yaml -f compose.qoj-browser.yaml pull
docker compose -f compose.yaml -f compose.qoj-browser.yaml up -d --wait
```

打开 `/admin/connections`，在专用桌面人工登录并核验。远程服务器通过 SSH 隧道访问回环端口 3000/6080，详细操作见[部署与运维](docs/部署与运维.md)。初次迁移暂停采集、关闭自动同步，默认只启用 Codeforces；确认成员账号后，在 `/admin/collection` 启用。洛谷/QOJ 先完成登录和核验，再加入采集。

## 部署方式二：自己打包镜像

取得源码后，在仓库根目录生成配置并构建。构建环境只需 Docker；下面用 Node.js 22+ 生成配置，也可以按方式一使用发布镜像运行初始化。

```bash
node scripts/setup.mjs
docker compose -f compose.yaml -f compose.build.yaml build
docker compose -f compose.yaml -f compose.build.yaml up -d --wait
```

需要自行构建 QOJ 浏览器镜像时，四份配置按下列顺序使用：

```bash
docker compose -f compose.yaml -f compose.build.yaml \
  -f compose.qoj-browser.yaml -f compose.qoj-browser.build.yaml build
docker compose -f compose.yaml -f compose.build.yaml \
  -f compose.qoj-browser.yaml -f compose.qoj-browser.build.yaml up -d --wait
```

普通镜像打包为 `acm-leaderboard:local`，浏览器镜像为 `acm-leaderboard:qoj-browser`。也可直接执行 `docker build --target runtime -t acm-leaderboard:local .` 或 `docker build --target worker-browser -t acm-leaderboard:qoj-browser .`。构建按锁文件安装依赖，执行类型检查及生产构建；后续启动仍使用对应的 build 覆盖配置。发布到自己的 Docker Hub、修改镜像标签及构建网络参数见[部署与运维](docs/部署与运维.md)。

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

发布包含新迁移的版本时，先备份、暂停采集并等待活动任务结束，再按[升级流程](docs/部署与运维.md)部署匹配的新 Web/worker。保留现有 QOJ 浏览器时，按[原位更新流程](docs/个人后端与Web登录.md)替换 Node worker，保持容器及 Chromium 运行。停止 Compose 默认保留数据库命名卷。当前源码是否已部署应由实际镜像和 readiness 确认，历史验收记录不代表运行环境自动更新。

当前采集策略：首次近 30 天、每批 3 页/120 秒，之后持续增量；榜单日期只控制查询，历史补采单独执行。结构与功能缺口见[项目实现状态](docs/项目实现状态.md)。
