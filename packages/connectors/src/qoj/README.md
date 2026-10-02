# QOJ 个人提交连接器

本目录负责账号解析、HTTP 响应分类和 HTML 标准化。公共读取流程位于 `core/application/collection`，浏览器、会话和人工处理位于 `core/application/platforms/qoj`。

运行、部署和人工接管见[QOJ 手册](../../../../docs/QOJ采集流程与技术维护.md)；请求/返回格式、数据库限流、连接租约及失败恢复见[采集文档](../../../../docs/采集架构与管理API.md)。历史真实回填结果见[2026-10-02 验收记录](../../../../docs/archive/2026-10-02-QOJ验收.md)。

## 请求与会话边界

正式队列和 CLI 使用 `readPlatform → createQojReadWorker → collectQojSubmissionPages/readAccount → qojConnector → RequestContext.request`。浏览器通过真实导航读取主文档响应体、状态和最终 URL；HTTP 200 的挑战页或登录页也必须分类为失败。

数据库策略默认 3000–5000 ms，平台并发 1；所有正式进程共享请求和连接任务租约。人工等待释放 HTTP 租约但保留连接任务租约。默认硬 HTTP 超时 30 秒、响应上限 4 MiB、最多两次临时网络重试；Retry-After 只能延长冷却。

CDP 模式复用容器的当前浏览器会话，不自动导入数据库 Cookie、不关闭外部默认 context。独立浏览器/Node jar 模式保留加密会话恢复；会话写回校验 generation 和租约。密码、Cookie、验证码与原始 HTML 不进入运行摘要或 fixture。

明确挑战归为 human_input_required；登录失效归为 auth_required；目标权限不足归为 restricted；结构不兼容归为 parse_changed。正常的 challenge-platform 子资源本身不等于挑战页，异常页面不能当作空历史。

## 字段、分页与完整性

入口是 `/user/profile/muhammad` 和 `/submissions?submitter=muhammad`。主页无时间 Accepted problems 只核对缺口，不制造原始提交/首次 AC。仅个人，不采队伍/VP或源代码。

真实页面每页 10 条，第二页为 &page=2；只带 submitter/page，不加状态、分数、语言或比赛过滤，同时校验最终 URL、筛选框、逐行作者和 active 页码。分页窗口不是总页数，越界可能钳制末页；只有正常表头、正确 active 页以及 next disabled 且无 href 才 history_end，异常空页必须失败。

提交/题目 ID 保持字符串，原站链接为 /submission/{id} 和 /problem/{id}，难度 null。包含所有状态，保留 nativeResult/nativeScore；100 分本身不当 AC，明确 Accepted/✓ 才 accepted。记录保存 qoj-html-1/observedAt，返回前 Zod 校验。错作者、错筛选、钳制页码、非法时间和结构变化失败。

时间来自 time datetime 的显式时区，页脚 Server Time UTC+8 辅助核对，存 UTC。两页真实样本：3073094 / 题目197 / Compile Error，`2026-10-01T18:12:21+08:00` → `2026-10-01T10:12:21.000Z`。主页通过题没有时间，不生成提交。

cursor/checkpoint v1 绑定账号、模式和 parser；每页边界重读前一页、按 ID 去重。未完回填不生成新 checkpoint，增量跨锚点后再读完整一页才 checkpoint_reached。超过一页的漂移须另跑顶部增量；backfill 与 incremental 用独立状态。

## 输出与验证

正式队列 output 使用公共 `PlatformReadOutcome`，完整提交在 `data.submissions`、题目在 `data.problems`，进度与续读位置在 `progress` 和 `continuation`；数据库运行表保存摘要。旧载荷仅保留消费兼容。

使用 `pnpm qoj:debug --target TARGET --pages 2 --enqueue` 投递按需读取。直接调试当前容器浏览器需明确指定 `--browser --browser-cdp http://127.0.0.1:9222`；`--memory` 仅用于显式临时调试，不保存正式运行记录。

fixture 覆盖解析、分页漂移、错误分类、取消、挑战和浏览器生命周期；真实验收只证明对应时刻的可见数据。自动登录、2FA、正式业务事实写入和周期调度仍未实现。
