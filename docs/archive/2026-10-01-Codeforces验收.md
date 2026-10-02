# Codeforces 验收（历史归档）

以下为 2026-10-01 的实现验收记录，命令和目录可能已变化。当前规则见[连接器说明](../../packages/connectors/src/codeforces/README.md)。

## 验证记录与限制

真实网络验证与 fixture 测试分别报告。2026-10-01 19:49—19:50（Asia/Shanghai），最终版本的宿主 Worker 使用空白临时 PostgreSQL 实测：

| 实测 | 结果 |
| --- | --- |
| tourist：user.info、user.status 两页 | count=5、from=1/5；原始 10 条、去重 9 条、7 道题。page_limit/more，回填未完成。 |
| tourist：资料、user.rating | 成功；308 条评级记录。 |
| MikeMirzayanov：首次完整增量 | 4 页，含确认结束的空页；原始 227 条、去重 187 条、87 道题；history_end，产生真实 checkpoint。 |
| MikeMirzayanov：使用该 checkpoint | 2 页；原始 200 条、去重 180 条；checkpoint_reached，产生下一轮 checkpoint。 |
| PostgreSQL 两个独立连接 | 租约互斥、释放后保留 2000ms 间隔、到期回收、旧 token 拒绝、共享封禁不能缩短，全部通过。 |

19:56 使用项目现有 DATABASE_URL 再次直接运行交付的 pnpm cf:read 命令，tourist 两页、资料和评级历史均成功；公开比赛 566 的匿名正式 standings 返回 625 行、7 道题，定向读取 566:A 返回原生难度 2300。standings 请求只传 contestId，没有查询 VP 名次。

真实 user.status 返回中存在作者成员与查询 handle 不匹配的记录；只保留此证据，不自动确认改名或个人归属。本机 Docker 容器直连 CF 返回 NETWORK_ERROR；宿主请求成功，没有将网络限制当成账号不存在。

可复现的独立网络验收（Docker、宿主网络、PowerShell；无需 CF 密码）：

```powershell
./scripts/cf-live-verify.ps1
```

脚本建立不含现有业务数据的临时 PostgreSQL，验证真实 Worker 分页和 checkpoint，在 finally 中移除临时容器与协议文件，不开放现有数据库端口。

pnpm check 全仓库 9 个测试文件、95 项通过；其中本任务 fixture 覆盖 verdict、结构变化、offset 增减及边界删除、队伍/VP、错误分类、请求上限、重试和调用编排。它们使用合成、去标识数据，不能替代真实网络验证。比赛辅助 fixture 覆盖 contest.status 范围、contest.list、standings 参数限制、未知名次和定向难度查询；未声称所有比赛或特殊题库均已网络实测。

pnpm build 与 Linux Docker 镜像构建通过。新增迁移已应用，原先运行旧镜像的 web/worker 已用匹配镜像重建；实际 readiness 和两个容器的健康状态均恢复，数据库保留。

CF 匿名读取不使用 Cookie。当前迁移包含平台配额表和并行平台任务增加的通用会话表；未创建平台账号、题目、提交、sync_cursors、sync_runs 等业务同步表。尚缺绑定版本校验、事实/游标原子入库、跨批去重、自动调度、pending 复查和旧历史重判复查。7 天窗口外的重判不保证自动发现，可重新回填。API 没有历史快照，持续变化列表不承诺某一时刻的完整快照。Web 绑定与榜单展示尚未开放。
