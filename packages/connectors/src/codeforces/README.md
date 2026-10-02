# Codeforces 官方 API 读取

读取适配器已在 registry 显式注册。平台请求和 Zod 解析位于本目录；core/application 编排有界批次；apps/worker 提供运行入口。连接器不写数据库、不投递队列，也不决定本站积分和归属。

依据：[官方方法](https://codeforces.com/apiHelp/methods)、[官方对象](https://codeforces.com/apiHelp/objects)。解析版本为 `codeforces-api-v1`。

## 已实现接口

| 读取方法 | 官方接口 | 说明 |
| --- | --- | --- |
| resolveAccount | user.info | 显式 checkHistoricHandles=true，返回官方 handle；externalId=null，不伪造 UID。保留请求 handle 和核对参数作为线索，不自动合并账号。 |
| fetchSubmissionPage | user.status | 从 from=1 开始，使用 count，保留全部 verdict 和最小原始证据，不请求源代码。 |
| fetchProfile | user.info | rating、历史最高 rating、rank、组织和注册 UTC 时间；不返回邮件或社交账号等字段。 |
| fetchRatingHistory | user.rating | 只覆盖评级比赛，保留评级更新时的名次；不能代替完整参赛或 VP 历史。 |
| fetchContestSubmissionPage | contest.status | 指定比赛及 handle，使用同样的有版本分页状态。 |
| fetchContests | contest.list?gym=false | 仅在显式请求时读取常规比赛列表。 |
| fetchStandings | contest.standings?contestId=… | 公开常规赛仅传 contestId，不追加 handles、showUnofficial 或分页参数；Gym/Mashup 的签名认证读取未实现。 |
| fetchProblem | 指定比赛的 standings | 查询指定 index 的难度；没有单题官方 API，须读取该场公开正式榜，不默认抓全站题库。 |

所有外部 ID 使用字符串，时间使用 UTC ISO。题目键为 contestId:index；原生 rating 可以为 null。缺少 contestId 的特殊题库不按名称制造身份，提交保留 problemKey=null，不推测题目链接。

提交保留原始 verdict、原站得分、链接、parserVersion、observedAt，以及实际 author.members、teamId、teamName、participantType、ghost、可用开始时间和 relativeTimeSeconds。queriedAccountMatchesAuthor 只记录返回成员是否与查询 handle 匹配；查询账号不替换实际作者，也不证明归属或改名。

OK → accepted；TESTING/SUBMITTED → pending；明确失败终态（含 PARTIAL）→ rejected；缺失或新增状态 → unknown。缺少原站得分时不制造 0，不根据分数推导 AC。

VIRTUAL 分类与多人/队伍证据分别保留。不产生本站个人/队伍归属，不按 relativeTimeSeconds 猜开始时间，不制造独立 VP 记录或 VP 名次。常规赛正式 standings 不提供 VP 名次；无法证实名次保持 null。

## Worker 命令

使用 Node.js 24.21.0、pnpm 11.19.0，并确保 DATABASE_URL 指向已迁移的 PostgreSQL：

```powershell
pnpm db:migrate
pnpm cf:read --target tourist --mode backfill --page-size 100 --max-pages 3
pnpm cf:read --target tourist --mode backfill --page-size 5 --max-pages 2 --with-profile --with-rating
pnpm cf:read --target tourist --mode backfill --contest-id 2268 --max-pages 3
pnpm --filter @acm/worker cf:read --target tourist --mode incremental --max-pages 3
```

默认每页 100 条，CLI 每批 3 页（公共 API 默认两页），总预算 120 秒；--budget-ms 可以调整。达到批次限制返回 cursor，不宣布历史完成。样例只输出提交 ID、题目键、UTC 时间、判题和成员数量等，不输出完整响应、成员名单或联系方式。

PowerShell 7 保存并续用协议状态：

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
$result = pnpm cf:read --target tourist --mode backfill --max-pages 3 | Select-Object -Last 1 | ConvertFrom-Json
$result.cursor | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8NoBOM .local/cf-cursor.json
pnpm cf:read --target tourist --mode backfill --cursor .local/cf-cursor.json --max-pages 3
```

首次增量没有 checkpoint 时扫描完整可见历史；分页续跑保持同一个旧 checkpoint。完成后保存输出中的 checkpoint，下一轮从首页开始：

```powershell
pnpm cf:read --target tourist --mode incremental --max-pages 10
pnpm cf:read --target tourist --mode incremental --checkpoint .local/cf-checkpoint.json --max-pages 10
```

cursor/checkpoint 文件只包含对应 JSON 对象，不包含整份运行摘要。输出将 handle 替换为指纹，输入只恢复与 --target 精确匹配的指纹；使用官方当前 handle 续跑。指纹用于脱敏展示，不是平台 UID。

按需辅助读取：

```powershell
pnpm cf:read --operation standings --contest-id 566
pnpm cf:read --operation problem --contest-id 566 --index A
pnpm cf:read --operation contests
pnpm cf:lease-probe
```

新镜像下可运行 `docker compose run --rm --no-deps worker pnpm cf:read --target tourist --mode backfill --max-pages 2`。迁移改变就绪检查版本，部署应按设计停止旧 Worker、迁移、使用匹配的新镜像重启 web/worker；旧镜像不会自动更新。

## 请求、分页与错误

- 每个真实 HTTP 均走 application 的公共 ctx.request。PostgreSQL platform_request_limits 保存 next_request_at、blocked_until 和有 token 的在途租约；web/worker 共用，部署不依赖进程内限速。
- CF 数据库策略默认 2000–3000 ms、最小 2000 ms，平台并发 1；读取响应体和处理会话前保持租约，释放时也保守预留间隔，避免准备阶段的延迟压缩实际请求间隔。默认 HTTP 超时 30 秒、租约 45 秒、响应上限 32MiB；限制 HTTPS 域名、重定向和内容类型，取消或失去租约时中止。
- HTTP 临时失败最多重试两次；API Call limit 也通过公共配额设置封禁截止时间，有界重试。Retry-After 秒数与 HTTP 日期均被遵守，其他客户端不能缩短现有封禁。
- cursor/checkpoint 版本为 1，绑定 handle、用户/比赛范围、模式、解析版本及本轮旧 checkpoint。版本不兼容或续跑时更换 checkpoint 返回 INVALID_CURSOR，应从首页安全重扫。
- 满页重叠 20%；校验上一页边界 ID，offset 漂移时从首页重新定位。短页后继续请求正常空页，才宣布可见历史结束。边界被删除时安全重扫，不跳过中间记录。
- 增量覆盖旧 checkpoint 开始时间之前 7 天；连续两页全部越过窗口才返回 checkpoint_reached，不会见到一个旧 ID 就停止。回填与增量 cursor 分开，回填不改写增量 checkpoint。
- 正常空数组是成功；history_end 与 checkpoint_reached 含义不同。预算耗尽/取消保留最后完成页的 cursor；诊断进度不推进失败页；数据库重试从原批次输入开始，只有已保存事实的本地工件才可按其游标续跑。每批按提交 ID 去重；跨批幂等入库尚未实现。
- ACCOUNT_NOT_FOUND、RATE_LIMITED、NETWORK_ERROR、TIMEOUT、CANCELLED、AUTH_REQUIRED、FORBIDDEN、PARSE_CHANGED、API_ERROR、HTTP_ERROR、RESPONSE_TOO_LARGE、LEASE_LOST、INVALID_CURSOR 分开报告；未知 FAILED 不归为账号不存在。结构错误诊断只输出字段路径，不输出原响应。

## 验证与限制

历史真实网络结果见[2026-10-01 验收记录](../../../../docs/archive/2026-10-01-Codeforces验收.md)。当前公共契约、运行落库和管理员接口见[采集架构与管理 API](../../../../docs/采集架构与管理API.md)。

读取结果不直接写正式提交事实或榜单；尚缺账号绑定版本校验、事实/游标原子入库、跨批业务去重、周期调度和重判复查。7 天增量窗口外的重判需重新回填。持续变化列表不保证某一时刻的完整快照。
