# 三平台采集架构与管理 API

更新：2026-10-02。适用于本次源码和迁移 `0002_empty_viper`；既有运行容器必须部署匹配的新版本后才能使用这些接口。

## 目录和依赖

依赖方向保持 `apps → core/application → db、connectors`。连接器负责平台解析和外站请求模板，不写数据库；应用层负责批次、鉴权、配额和记录；HTTP 与 CLI 只处理输入输出。

- `apps/worker/src/runtime`：启动、队列注册、心跳及鉴权恢复扫描。
- `apps/worker/src/cli`：三平台命令及人工输入。旧文件和原命令保留为兼容入口。
- `packages/core/src/application/collection`：统一契约、读取、请求控制、连接任务租约、运行记录、管理用例。
- `packages/core/src/application/platforms`：CF 请求上下文、洛谷会话/登录、QOJ 浏览器/会话/人工处理。
- `packages/connectors/src/contracts`：浏览器可使用的纯类型。平台解析器和样本仍在各平台目录。
- `packages/db/src/collection`：具体 SQL helpers；表定义仍集中在 `schema.ts`。

新增服务端读取用例统一调用 `readPlatform(input, runtimeOptions)`。不要在新调用方直接循环连接器或调用 QOJ transport worker；后者负责浏览器生命周期，由公共读取流程管理持久化及跨进程连接租约。

## 公共读取格式

输入示例：

```json
{
  "platform": "luogu",
  "target": "863154",
  "mode": "backfill",
  "maxPages": 2,
  "maxDurationMs": 120000,
  "cursor": null,
  "checkpoint": null
}
```

平台 ID 为 `codeforces / luogu / qoj`。个人账号输入统一为 `target`；解析后身份使用 `account`。洛谷、QOJ 默认连接为 `luogu-lab / qoj-lab`，可通过对应 `*_CONNECTION_ID` 配置；正式 QOJ 队列只能使用其配置的专用连接。

默认两页、120 秒，预算上限 900 秒。洛谷最多 100 页，其他平台最多 1000 页。`signal`、回调、浏览器实例和测试注入属于运行参数，不进入数据库或队列请求。输入拒绝未知字段，禁止通过任务传递凭据或覆盖限流参数。

统一结果包含：

```text
runId, platform, account, collector, status,
batchStatus, stopReason, coverage, historyComplete,
progress: { pages, rawRecordCount, uniqueRecordCount, problemCount },
continuation: { cursor, checkpoint },
data: { submissions, problems, profile, ratingHistory, auxiliary? },
error: null | { code, message, httpStatus, retryAt, action }
```

固定字段无值时使用 `null`；时间使用 ISO 8601。`collector` 是真实核验后的采集账号标识：CF 为 null，洛谷为 UID，QOJ 为 handle。平台原生判题字段及身份证据保持既有语义。

`status` 表示该次执行的业务结果：`completed / auth_required / human_input_required / restricted / parse_changed / timeout / cancelled / failed`。`batchStatus` 为 `complete / page_limit / budget_exhausted / cancelled`。`stopReason` 为 `more / history_end / checkpoint_reached`。

达到页数限制可以成功结束本批次，`historyComplete` 仍为 false；增量到达 checkpoint 也不等于完整历史回填。数据库运行记录保存摘要，完整返回数据通过调用结果或 pg-boss output 获取，不写正式提交事实表。

CF 支持现有资料、评级和比赛辅助读取；不支持的能力返回 `NOT_IMPLEMENTED`。普通错误的处理动作分为 `retry / reauthenticate / human_verify / fix_target / fix_parser / unsupported / none`。目标 403 不使整个连接失效，5xx 不归类成重新登录；CF 公共接口无需平台密码。

## 数据库限流与连接状态

`platform_request_policies` 保存 `minIntervalMs / maxIntervalMs / version / updatedAt / updatedBy`。首次迁移默认 CF 2000–3000 ms，洛谷和 QOJ 3000–5000 ms；既有 `*_MIN_INTERVAL_MS` 只初始化缺失策略。再次迁移不会覆盖管理员设置。

每次获得配额读取数据库策略，并在闭区间内抽取整数间隔；同一次请求释放时沿用该间隔，从完成时继续等待。各平台并发 1，所有正式进程共享 `platform_request_limits`。等待和在途 HTTP 都可取消；失去租约后不能发布结果或写入 Cookie。`Retry-After` 冷却只能延长，修改策略不重置租约或已安排的等待。

CF 最小间隔 2000 ms，其他平台 1000 ms；最大间隔不超过 60000 ms，最小值不得大于最大值。QOJ 计量程序导航和登录 XHR，浏览器必要资源和管理员手动操作不逐个套用间隔。

`platform_connections` 保存状态、身份、generation、Cookie 修订及连接任务租约。等待人工操作时释放 HTTP 租约，同时保留连接任务租约，阻止其他进程交错操作同一个浏览器。Cookie 轮换与重新鉴权分开版本控制，旧任务不能覆盖新会话。

QOJ CDP 模式继续以容器浏览器的当前会话为准；不自动导入数据库 Cookie，不关闭容器拥有的浏览器。

## 管理 API

所有接口需要有效管理员会话。写请求还需要与 `APP_URL` 相同的 `Origin` 及登录返回的 `X-CSRF-Token`。响应为 `Cache-Control: no-store`，错误保持 `{code,message,requestId,retryAt?}`；不返回加密会话或外站原始响应。

| 接口 | 入参或行为 |
| --- | --- |
| `GET /api/admin/platforms` | 返回各平台能力、默认连接、限流、最近失败和鉴权操作说明 |
| `PATCH /api/admin/platforms/:platform/rate-limit` | JSON `{minIntervalMs,maxIntervalMs,version}`；版本冲突 409 |
| `POST /api/admin/read-runs` | 公共读取输入；202 `{runId,jobId,merged}` |
| `GET /api/admin/read-runs` | `platform/status/action/limit/cursor`；默认 20、最多 100；返回 `{items,nextCursor}` |
| `GET /api/admin/read-runs/:id` | 运行摘要、原始读取参数、诊断进度、错误及恢复关联 |
| `POST /api/admin/read-runs/:id/retry` | 手动重试失败运行；202；同一请求重复投递返回已有 ID |
| `POST /api/admin/connections/:platform/verify` | 洛谷/QOJ JSON `{target}`，核验真实身份并读取一页；202；CF 返回无需登录 |

队列载荷只有 `{version:1,runId}`，实际安全读取参数从运行表取得。参数相同的未完成请求事务去重，不把不同游标或预算的请求合并。旧 QOJ 队列载荷仍可消费，结果提供旧字段兼容。

## 失败与重新鉴权

读取开始前先创建运行记录，每页保存诊断进度，最终保存业务结果。失败历史保留；即使队列完成，也必须检查业务 `status`。

1. 洛谷用现有工具重新登录：`pnpm luogu:read --login --target TARGET --username COLLECTOR`。临时会话核验身份及目标读取后才替换正式密文；失败保留旧会话。
2. QOJ 在专用浏览器/noVNC 完成登录或挑战；仍在等待的任务按现有确认工具操作。任务已结束时，调用上述连接核验 API，指定可读取目标。
3. 成功鉴权/核验推进 generation。worker 每 15 秒扫描未解决的待鉴权请求并自动投递，不依赖未来周期同步的 `SYNC_ENABLED`。
4. 同一请求在同一核验版本最多自动重投一次；再次鉴权失败等待新的核验。目标受限、解析变化、网络失败由管理员按错误动作处理，不进入鉴权恢复循环。

**重试从原批次输入游标开始，不能从诊断进度继续。** 本次运行表不提交正式采集事实，直接跳到“最后成功页”可能遗漏数据。重试允许重复读取，并关联旧失败与新运行；成功后标记恢复链已解决。

异常退出和队列超时由维护扫描补齐终态。直接 CLI 崩溃在其预算加 60 秒后可被识别。运行摘要默认保留 30 天，未解决鉴权记录保留；审计保留 180 天。密码、验证码、Cookie、完整 HTML 和未知异常文本不进入运行摘要。

## 验证与部署

```powershell
pnpm check
pnpm build
pnpm db:migrate
pnpm cf:read --target tourist --enqueue
pnpm luogu:read --target 863154 --enqueue
pnpm qoj:debug --target muhammad --enqueue
```

`pnpm collection:probe` 只允许连接名为 `acm_architecture_verify` 的全新独立测试数据库，会创建测试用户、队列和调整测试配额；重复运行前重建该测试库，禁止将探针接到业务数据库。加 `--http` 时要求同一测试环境在 `http://localhost:3001` 运行匹配的新 Web。

发布前先备份并停止旧 worker，执行迁移，再部署匹配的新 web/worker。不要只对旧运行镜像执行迁移，其 readiness 版本检查会失败。重启/重建 QOJ 浏览器可能丢失当前登录状态，应按 QOJ 维护文档准备人工重新鉴权。源码实施和独立测试不要求重启当前浏览器。
