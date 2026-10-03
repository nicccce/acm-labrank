# 个人后端与 Web 登录

已实现三平台个人绑定、按需同步、正式事实存储及查询 API。管理员采集配置见[管理员采集管理](管理员采集管理.md)，普通成员页面、姓名编辑、队伍管理与团队榜见[成员页面与团队榜](成员页面与团队榜.md)；独立比赛/VP、外站队伍绑定和归属纠正后续实施。2026-10-03 管理员完成登录并确认后，已验证三平台两页真实列表的作者、分页、时间、原始判题和当前采集身份，随后热启用提交采集，验证正式入库、重复请求合并及独立批次自动续投。

## 本地交接

```powershell
node scripts/setup.mjs
docker compose pull
docker compose up -d --wait
docker compose run --rm --no-deps seed
```

打开 <http://localhost:3000/admin/connections>，使用已有本站管理员登录。初始用户名见 `.env` 的 `ADMIN_BOOTSTRAP_USERNAME`，密码从 `.secrets/admin-bootstrap-password` 本地读取。QOJ 的 VNC 密码见 `.secrets/qoj-vnc-password`，手动输入，不能放进 URL。

初次迁移的 `collection_control.enabled=false`。账号候选保存为待验证，恢复采集且对应平台启用/登录后才入队；worker 不消费提交/绑定队列，不进行自动鉴权恢复。独立 QOJ 身份核验仍可运行。洛谷成功登录只访问登录、验证码及身份页面，不读提交列表。QOJ 核验仅访问身份入口 `/`。

CF 可独立启用；需要 QOJ/洛谷时先完成相应登录和平台选择。启停以数据库为准，worker 最迟约 15 秒观察到变更，无需重启浏览器。再次迁移保留已有开关值；暂停期间已提交事实和游标保留。

种子脚本创建 `test_member` 和 `test_empty`，不重置已有密码或绑定。前者默认候选为 CF `tourist`、洛谷 `863154`、QOJ `muhammad`；可通过 `--cf`、`--luogu`、`--qoj` 指定。测试密码从 `.secrets/member-test-password` 本地读取。候选仍须真实验证，不直接伪造已验证账号。

## 登录接口

所有接口仅管理员可用；写入同时要求本站 Origin 和 `X-CSRF-Token`。`POST /api/auth/login` 返回 CSRF token 并设置 HttpOnly 会话 Cookie。

| 路由 | 输入及行为 |
| --- | --- |
| `POST /api/admin/connections/luogu/login-attempts` | `{username}`；返回 `id/version/expiresAt/captchaUrl` |
| `GET /api/admin/connections/luogu/login-attempts/:id/captcha` | 仅创建者会话；返回同一版本的图片，无缓存 |
| `POST .../:id/submit` | `{version,password,captcha}`；成功返回平台 UID、姓名，读取权限待验证 |
| `POST .../:id/refresh-captcha` | `{version}`；生成新图片并递增版本 |
| `DELETE .../:id` | 取消、销毁临时状态，晚响应不能发布会话 |
| `POST /api/admin/connections/qoj/verify-session` | 纯身份核验，返回 `runId/jobId` |
| `GET /api/admin/read-runs/:runId` | 核验状态和结果摘要，不返回 Cookie |
| `DELETE /api/admin/connections/:platform` | 撤销本站连接并递增 generation；不删除采集事实 |
| `GET/PUT /api/admin/collection-control` | PUT 输入 `{enabled,version}`，并发版本冲突返回 409 |

洛谷尝试有效期 10 分钟，绑定创建者本站 session。临时 Cookie/CSRF/state 加密入库，验证码图片短期保存；密码和验证码文本不持久化。重登失败保留旧连接。成功发布在同一事务中再次检查尝试状态、版本、期限、创建者会话及连接 generation。

密码登录请求按官网发送 JSON 与 CSRF。成功以当前会话的已认证 UID 为准；登录失败分别显示验证码、账号密码、CSRF、两步验证、限流或安全验证等原因。只匹配洛谷错误信息并返回固定提示，不转发原始错误正文，防止平台错误回显凭据；日志仅保留错误类别与 HTTP 状态。所有密码 POST 均不自动重试。

QOJ 复用容器内 Chromium 的默认 context，不恢复数据库 Cookie 到 CDP 浏览器。默认 noVNC iframe 地址为 `http://localhost:6080/vnc.html?autoconnect=1&resize=scale`，可配置 `QOJ_VNC_URL`。默认不走旧的 CLI 接管确认；遇到登录或挑战时在 iframe 完成人工处理，再点击身份核验。

## 个人和同步接口

| 路由 | 输入及行为 |
| --- | --- |
| `GET/PUT /api/me` | PUT `{realName:string|null}`，最多 64 字 |
| `GET /api/me/platform-accounts` | 生效账号、当前候选和回填状态 |
| `PUT /api/me/platform-accounts/:platform` | `{target}`，洛谷使用 UID；返回验证任务，已生效的已证实身份无变更 |
| `DELETE /api/me/platform-accounts/:platform` | 解绑、取消旧任务并撤销全部个人历史归属 |
| `POST /api/admin/sync` | `{accountIds?,platforms?,mode?,from?,to?}`；默认所选平台的生效目标、增量模式及管理员区间；日期须同时提供，最多 366 天 |
| `GET /api/admin/sync-jobs/:id` | 业务状态、队列状态、批次、页数、区间 `range`、`rangeComplete`、`stopReason` 与历史完整性 |
| `POST /api/admin/sync-jobs/:id/retry` | 重试失败/暂停任务，从正式事实对应的游标续跑 |
| `GET /api/leaderboard` | 个人积分、题数、分平台题数、最近首次 AC、并列排名 |
| `GET /api/members/:id` | 成员资料、区间积分/题数、提交数、分平台统计、首次 AC 日历 |
| `GET /api/members/:id/solves` | 首次 AC 题目、原生难度、当前分值、难度更新时间与链接 |
| `GET /api/members/:id/submissions` | 原始提交明细，含判题、原站分数及时间 |

查询要求登录。公共参数：`days=7|30` 或同时提供 `from/to=YYYY-MM-DD`，自定义最多 366 天；可选 `platform=codeforces|luogu|qoj`；`page` 从 1 开始，`limit` 默认 20、最多 100。所有错误沿用 `{code,message,requestId,retryAt?}`，所有响应禁止共享缓存。

显示名读取时使用真实姓名、当前已验证 CF handle、本站用户名的优先级。CF 历史 handle 经平台证实才建立别名；洛谷身份以 UID 为准；QOJ 不假定大小写等价。替换失败不影响旧账号，成功切换后全部个人历史随当前绑定重新归属。

## 存储与统计

提交按 `(platform, external_submission_id)` 唯一；题目按平台稳定键唯一。每页的题目、提交、归属、游标和进度原子提交，失败页不推进。旧绑定、游标或连接版本不能写回。不完整字段保留已知值，明确新判题可以使原 AC 失效，较旧观察不能覆盖较新事实。

首次 AC 在全部有效历史里求最早，再过滤北京时间 UTC 半开区间。积分沿用原有难度分档，规则版本为 `v2`；题目难度变化会改变历史区间积分。CF 组队提交按当场完整、去重且忽略大小写的作者成员列表归属给当前已绑定成员，每人积分为题目基础分 / 实际队伍人数，未绑定或停用成员仍计入分母。每人同题只计首次 AC；后续个人 AC 不补足先前组队 AC 的分数。ghost、作者证据不一致或缺失的记录保持未归属；查询账号不替代作者。其他平台仍只允许明确单人归属，QOJ 队伍账号不允许个人绑定。积分内部保留小数，页面最多显示三位小数。迁移 `0009_cf_shared_credit` 自动重算已保存 CF 提交的归属，无需重抓已有记录；解绑、替换和重绑会重算该成员出现在任意作者位置的历史分摊。

默认批次最多 3 页、120 秒，成功后有界续投；周期调度见[管理员采集管理](管理员采集管理.md)。逻辑运行 ID 不变，新批次独立 job ID 和 singleton key；提交游标是恢复依据，读取运行的诊断 continuation 不是业务游标。临时错误最多自动重试 3 次；登录/挑战暂停等待新的核验 generation，解析变化须修复后手动重试。

新绑定首次采集使用管理员设置区间，初始默认近 30 天。管理员可通过同步接口指定单次北京时间首尾日期，例如：

```json
{"accountIds":["已绑定的平台账号 UUID"],"mode":"incremental","from":"2026-09-01","to":"2026-09-30"}
```

首次采集没有可复用游标也会在跨过起始日期时停止，返回 `stopReason="range_start"`、`rangeComplete=true`，不再自动向更早日期续投。每页仅将区间内提交及其题目入库；首尾日期均包含。平台无日期跳转能力时仍需经过区间之后的较新页面；达到下界后不请求下一张更旧页面。日期缺失或次序异常会暂停，避免误报区间完整。

区间任务各自保存恢复游标和版本。相同范围的活动任务合并；不同范围不合并，返回目标错误 `SYNC_RANGE_CONFLICT`。扩大到更早日期时不使用会提前停止的旧 checkpoint；已有覆盖足够时复用增量 checkpoint。终止页提交后即保存 `rangeComplete`，中断重试只完成任务状态，不从首页重新开始。

回填与增量分开。区间采集完成不表示全部历史完整，即使读到了自然末页也不认定 `historyComplete=true`。首次 AC 仍是在已采集历史中求最早，历史不完整时积分和首次 AC 返回 `provisional=true`；更早历史可能修正结果。旧版本的完整历史和已有事实均保留。响应提供 `ruleVersion/asOf/range/coverage/provisional`，不保存可人工写入的榜单总分或名次。

## 检查与更新

```powershell
pnpm check
pnpm build
docker compose run --rm --no-deps --entrypoint pnpm web personal:verify
```

`personal:verify` 使用随机命名的独立测试库和本地 HTTP 样本，不访问真实平台。成功后删除该测试库；失败时保留库名供诊断。它不会改变正式库的配额、会话和用户数据。

发布先备份数据库、停止旧 web/worker、执行迁移，再启动匹配镜像。保留 `acm-leaderboard_pgdata` 卷；禁止使用 `down -v` 清空数据。QOJ 用户完成登录后不再重建浏览器容器。

需要在当前 Chromium 登录会话中更新 worker 时，先暂停采集并确认没有活动任务，只复制源码文件（不要复制 Windows 的 `node_modules`），完成迁移及离线测试后，可在 Linux Node 24 容器内使用 `scripts/worker-network-hot-apply.mjs --reload-worker`。该选项用 `execve` 原位替换 Node worker，保持 PID、Chromium、noVNC 及数据库卷；只开启并关闭容器内部本地调试连接，不发布新端口。仅原位更新时保留进程原有网络设置；若同时配置 `PLATFORM_HTTPS_PROXY`，也会更新代理调度器。后续正常镜像构建仍须包含更新后的源码。

常规安装直接拉取 Docker Hub 的匹配应用与通用 Worker 镜像；源码构建只需追加 `compose.build.yaml`，完整命令见[部署与运维](部署与运维.md)。依赖本机历史镜像的缓存构建文件已移除。网络受限时使用发布镜像或向标准 Dockerfile 指定可信源。

Docker Desktop 无法直连平台时，可复用宿主机现有 HTTP 代理：在本地 `.env` 设置 `NODE_USE_ENV_PROXY=1` 和 `PLATFORM_HTTPS_PROXY=http://host.docker.internal:7890`。Web/Worker 的 Node 请求使用 Node 24 的内置环境代理，`NO_PROXY` 排除本站及内部容器请求；保持宿主机代理运行。QOJ 的 Chromium 如需代理，另设 `QOJ_BROWSER_PROXY_SERVER=http://host.docker.internal:7890`，修改后需重建 Worker 并重新确认浏览器登录。

`web:probe` 默认仅运行离线 UI/API 检查；设置 `WEB_PROBE_LUOGU_CAPTCHA=1` 可额外通过管理页实际获取、重复读取、刷新和取消洛谷验证码，不填写密码、不提交验证码、不读取提交列表。

`scripts/live-read-probe.ts` 是需管理员明确确认后才运行的真实读取探针，每平台最多两页，在采集暂停时执行，不写提交事实。QOJ 探针在已有 worker 中通过容器内部 CDP 连接，退出只断开自身连接，不关闭专用 Chromium。

`scripts/live-acceptance.ts` 使用本地管理员凭据调用正式 API，支持 `identity`、`enable/pause`、`sync`、`job/retry`、`member`、`status`、`accept` 和 `range-accept`。`sync` 可附加账号 UUID、from、to；`range-accept @文件.json` 接受最多三项 `{accountId,platform,day}`，逐项验证一天区间的回填和增量完成。它不输出密码或本站会话；遇到登录限流按 `retryAt` 等待，不清空限流记录。真实读取验收只能在管理员完成登录并确认后运行。

2026-10-03 日期截断验收：CF `tourist` 的 2026-09-27、洛谷 UID `863154` 的 2026-05-21、QOJ `muhammad` 的 2026-10-03，一天区间的回填和后续增量各读取 1 页，均以 `range_start` 完成，分别保存 1、1、2 条区间记录。169 项离线测试、生产构建、独立数据库的首次扫描/范围合并/扩大区间/事务失败/终止页中断恢复均通过。部署中的迁移版本就绪检查问题已修复，并纳入独立数据库验收；QOJ 登录从更新前加密备份恢复后通过真实身份核验，无需重新输入凭据。

`scripts/live-data-probe.ts` 只读核验正式事实的唯一性、题目平台一致性、个人归属和业务游标，输出计数及任务状态；不修改配额、会话、用户或提交。部署验收的真实平台数据会保留在现有数据库卷中。

2026-10-03 持续增量升级：运行记录增加 `scope` 与首次下界，游标增加初始化完成时间；迁移为 `0008_continuous_incremental`。首次近 30 天完成后持续增量，日期仅控制查询，历史区间补采不推进增量检查点。最新结构与功能缺口见[项目实现状态](项目实现状态.md)。缓存镜像构建现在清除旧源码，并保留 Next.js 在 `.next/node_modules` 生成的运行依赖链接；宿主依赖目录仍不复制到镜像。
