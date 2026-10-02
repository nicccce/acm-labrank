# 洛谷个人原始提交连接器

实现位置：`index.ts`（读取）、`parser.ts`（解析与 Zod 校验）、`login.ts`（独立登录）。已注册 registry，经 `core/application/luogu.ts` 的 `collectLuogu`、`beginLuoguLogin` 提供 Worker 调用。所有请求经过 `RequestContext.request`，复用 PostgreSQL 公共独占请求租约、限速、超时、取消、响应大小限制及 Cookie hooks；默认洛谷间隔 3000 ms。密码 POST 不自动重试。

## 本轮实测状态

日期：2026-10-01，Asia/Shanghai；真实登录与跨进程复验完成于 21:19。采集身份 `Nick1024` 与测试目标 `MD_Aurora` 分开。

| 能力 | 本轮结果 |
| --- | --- |
| Node.js 用户名解析、UID 反查、资料对照 | `MD_Aurora → 863154 → MD_Aurora`，已验证 |
| 不存在账号 | 实际返回 404、`NotFoundHttpException`、`找不到用户` |
| 浏览器目标提交列表 | 1295 条、`perPage=20`、65 页，已打开两页 |
| 原生状态与时间 | 第一页 `12=Accepted`、`14=Unaccepted`，Unix 秒与网页北京时间对照，已验证 |
| Node.js 登录准备 | 实际登录页、CSRF、官方路由配置、login-methods、当前图片验证码成功取得 |
| 正确密码 POST、Node.js 登录身份及 Worker 两页读取 | 成功；采集身份核对为 `Nick1024`，目标为 `MD_Aurora` / `863154` |
| 加密 Cookie 跨进程复用 | 成功；新 Worker 进程以用户名和数字 UID 均读取两页 |
| practice | Node.js 可见 507 个 passed、7 个 submitted，仅作核对 |

已通过实际连接器及公共 PostgreSQL 请求租约再次实测用户名/UID、practice、不存在账号；未登录提交读取实际返回 AUTH_REQUIRED。原网页第二页样本：262465152 / P4779 / status=12 / submitTime=1770781325；262442174 / P3386 / status=12 / submitTime=1770776060；作者均 863154。

真实 Worker 登录批次读取 2 页、40 条唯一提交、17 个题目，状态分布为 accepted 24 / rejected 16，原生状态为 12、14；随后两个新 Worker 进程分别以 `MD_Aurora` 和 `863154` 复用数据库加密 Cookie，得到同样结果。最早提交时间为 `2026-01-29T10:16:02.000Z`，最晚为 `2026-05-21T08:20:45.000Z`。数据库中实际 envelope 为 version 1，包含 keyId/nonce/tag/ciphertext，未出现采集或目标用户名明文。最终 `pnpm check` 为 10 个测试文件、100 项测试通过，`pnpm build` 通过。不以浏览器成功或 fixture 代替 Worker 验证。

## 真实用户名查询入口

从当前官方前端 `GET /_lfe/config` 的 `route["user.card_info"]` 及 UserFloatCard 实际调用核对出 `/user/cardinfo`，参数是 `user`。本轮请求：

```text
GET https://www.luogu.com.cn/user/cardinfo?user=MD_Aurora
Accept: application/json
响应 {"user":{"uid":863154,"name":"MD_Aurora", ...}}

GET https://www.luogu.com.cn/user/cardinfo?user=863154
响应 user.uid=863154, user.name=MD_Aurora

GET https://www.luogu.com.cn/user/863154
HTML script#lentille-context: template="user.show", data.user.uid/name
```

这是已验证的站内 JSON 路由，未声称有公开官方 API 的稳定性承诺。通用 `resolveAccount` 接受任意用户名/正整数 UID；数字输入用字符串，去掉前导零。用户名要求返回 name 与输入区分大小写逐字相同；不会接受模糊搜索第一条、别名或近似匹配。再访问返回 UID 的资料页核对 UID 与姓名。没有硬编码用户名映射。

`ACCOUNT_NOT_FOUND`（不存在）、`ACCOUNT_AMBIGUOUS`（精确匹配/UID 对照冲突）、`AUTH_REQUIRED`、`TEMP_UNAVAILABLE`、`RATE_LIMITED` 和 `PARSE_CHANGED` 分开处理。

## 登录及验证码

以下路径/字段来自本轮实际登录 HTML、其官方前端脚本及官方页面配置，不依赖非官方文档认定 POST 可用：

1. `GET /auth/login` 建立独立临时 Cookie jar，读取 `meta[name="csrf-token"]`。
2. 页面声明 `/_lfe/config/auth`，核对 `auth.login_methods=/auth/login-methods`、`do_auth.password=/do-auth/password`、`captcha=/lg4/captcha`；变化时拒绝发送凭据。
3. `GET /auth/login-methods?login={登录标识}`；本次响应 `{available:["password"],default:"password"}`。登录标识与目标数据用户名独立。
4. `GET /lg4/captcha?_t={毫秒}`，同一 jar 取得当前图片。展示实际图片等待人工输入；刷新将旧 state 标为 consumed 并递增 version。旧版本、不同会话、过期挑战不能提交。
5. 当前官方 PasswordAuthenticator 构造 JSON `{username,password,captcha}`，实际前端指定 `POST /do-auth/password`，带 `Content-Type: application/json`、`X-CSRF-TOKEN`，同一 Cookie、Origin/Referer。本轮人工验证码已通过该流程成功登录。
6. 登录适配器要求 `redirectTo`，再 `GET /` 从顶层 `user.uid/name` 核对指定采集身份；执行目标解析及两页读取，成功才发布正式 Cookie。登录适配器与读取适配器分开。

密码、验证码文本仅在当前进程调用使用，完成后清空输入引用；不写文件、数据库、队列或日志。临时 jar 在内存；正式 jar 使用 `SESSION_ENCRYPTION_KEY_FILE` 的独立 32 字节 hex Secret 作 AES-256-GCM 加密。envelope 有 version/keyId/nonce/tag/ciphertext，AAD 绑定洛谷与 connection ID，保存在 PostgreSQL `connector_sessions.encrypted_session`。取得请求租约后读最新 jar，释放前保存轮换 Cookie；Cookie/Set-Cookie 不向 CLI 输出。

图片是短时挑战文件，刷新覆盖，结束/取消/超时清理；尝试 10 分钟有效。当前实现 Worker/应用登录入口，未交付完整管理员页面、管理员会话绑定的持久化 login attempt、断开及 generation/cookie_revision 生命周期。二次认证或原域风控需要人工处理；不能自动解验证码。

## 提交、难度与时间依据

`GET /record/list?user={解析后 UID}&page={从 1 开始的实际页号}`，不加 status/pid/contest 筛选。响应是 **HTML 内嵌 JSON，不是独立官方提交 API**：

```text
script#lentille-context:
  template="record.list"
  user = 当前登录采集身份（不是目标）
  data.records = {count,perPage,result:[...]}
  result[] = {id,status,score?,submitTime,user:{uid,name},
              problem:{pid,name,difficulty,...}|null,contest?:{id,name,...}|null,...}
```

逐条核对作者 UID 必须等于目标；匿名作者返回 `PRIVACY_RESTRICTED`，不会误采采集账号。提交 ID/contest ID 使用字符串，数值超过 JS 安全整数拒绝解析。保留 pid、nativeStatus、nativeScore（缺失不伪造 0）、作者 UID/姓名、可见 contest ID/name/mode、原站链接、parserVersion、observedAt。标准记录返回前做 Zod 校验，连接器不决定积分。

当前 `/_lfe/config.RecordStatus` 与实际列表对应：12→accepted；0 Waiting/1 Judging→pending；2 CE/3 OLE/4 MLE/5 TLE/6 WA/7 RE/14 Unaccepted→rejected；-1 Unshown/11 Unknown Error/21–23 Hack/未知 ID→unknown。不能 score=100 判 AC；实际第一页有无 score 的 status=12 AC。

`submitTime=1779351645` 对应 UTC `2026-05-21T08:20:45.000Z`，网页北京时间 `05-21 16:20:45`，确认 Unix 秒。乘 1000 转 ISO UTC，不额外加减时区；缺失为 null，不制造首次 AC。

难度按当前 `/_lfe/config.ProblemDifficulty` 的 ID/name 核对：0 暂无评定→null；1 入门；2 普及−；3 普及；4 普及+/提高−；5 提高；6 提高+/省选−；7 省选/NOI−；8 NOI/NOI+/CTS。缺失/未知为 null，不根据颜色猜测。

## 分页及覆盖

- 使用真实 count/perPage/result，不固定 20 条。本目标实测 1295/20，因此 65 页。
- cursor/checkpoint 都 version=1，绑定 parser、uid；cursor 另绑定 mode，backfill/incremental 分开。续页整页重读上一页，按提交 ID 去重，核验边界锚点。
- count/页大小变化、重叠锚点消失、结束前首页 head/count 变化返回 `PAGINATION_DRIFT`，保留事实并从 cursor=null 重扫，不能跳过失败页或推进 checkpoint。当前采取保守重扫，不保证动态列表可形成快照。
- incremental 找到上次 checkpoint.head 后再读两整页，才允许 checkpoint_reached；找不到则继续到正常终止页。扫描未完成 nextCheckpoint=null。
- backfill 仅在目标匹配、正常明确末页、首页稳定时 history_end。登录、风控、权限、隐私、结构变化分开报错，不能当成空页；只有正常 count=0 页可作为可见空历史。
- coverage=visible/history_end 只表示遍历采集账号当前可见列表，不能证明隐藏记录全部公开。

## 运行命令

要求项目 Node.js 24 / pnpm 11。本机固定 Node 在父目录 `.local/runtime/node_modules/node/bin/node.exe`，将此目录加入 PATH。配置 .env 与 Secret：

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d db
pnpm db:migrate

# 建立独立会话；不接受密码命令行参数。
pnpm luogu:read --account MD_Aurora --login --username Nick1024
# 看实际图片后在无回显标准输入提交 JSON：
# {"action":"login","version":1,"password":"当前密码","captcha":"人工字符","expectedHandle":"Nick1024"}
# 刷新 {"action":"refresh","version":1}；取消 {"action":"cancel"}

# 新进程复用数据库加密 Cookie，目标可用用户名或 UID。
pnpm luogu:read --account MD_Aurora --mode backfill --max-pages 2
pnpm luogu:read --account 863154 --mode backfill --max-pages 2

# 可选本地调试工件：按页原子保存标准事实及两种独立扫描位置。
pnpm luogu:read --account MD_Aurora --mode backfill --max-pages 10 --state .local/luogu/md-aurora.json
pnpm luogu:read --account MD_Aurora --mode incremental --max-pages 10 --state .local/luogu/md-aurora.json
```

CLI 只输出核验、页数、去重提交/题目数、verdict/nativeStatus 分布、UTC 范围和覆盖进度。可选 state 文件含原始标准事实/游标，不含秘密；它是本地调试工件，不是生产提交数据库表。`collectLuogu.onPage` 供后续生产单页事务写入使用；本轮未交付完整队列调度、榜单或首次 AC 持久化。

## 样本与功能边界

fixture 基于本次真实字段结构，删除头像、签名等无关数据，替换作者/提交 ID、缩小 count/perPage 验证边界，不是测试目标的 mock 获取结果。测试覆盖账号精确解析、歧义/不存在、状态/秒时间/contest、分页重叠、增量窗口、漂移、隐私、登录失效、风控、结构变化、挑战刷新/会话绑定及认证加密防篡改。

保持 teamEvidence=false、participations=none。contest 不证明 VP，团队成员不证明比赛组队。practice 实际 template 也是 user.show，data.passed[] 为通过题、data.submitted[] 为尚未通过题；只作核对，不生成提交时间/首次 AC、不补齐不可见提交。
