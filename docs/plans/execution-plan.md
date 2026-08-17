# dsh GitHub 连接器 — 执行计划

> 状态：v1（M1–M7）全部完成（见根 [CHANGELOG.md](../../CHANGELOG.md)）；v2「审查闭环」（范围决策见 [ADR-0012](../adr/0012-pr-review-loop-enters-scope.md)）：**M8（审查读侧）与 M9（结构化审查）已完成**，M10 已拆解、未开工。dsh 宿主 CLI（`@deepseek-ai/dsh`）已验证可安装并激活本连接器（`dsh.bundle` patch，见 M3 验收注记）；仅剩两项手工验收挂起：M3 的模型驱动 CLI 走查（只差真实 API key）与 M6 的端到端 UI 脚本（dsh 源码核实后绑定路径已定：连接入口为"插件配置"卡片、端口映射见 [ADR-0008](../adr/0008-settings-card-entry-and-real-slot-binding.md) 与 design §7，待 client 适配层落地后执行；脚本已写入 [PR #5](https://github.com/kaziii/dsh-github-connector/pull/5) 描述）。依据 [design.md](../design/design.md) 拆解为可直接开工的里程碑与任务清单，设计取舍的理由见 [ADR](../adr/README.md)。
> 原则：每个里程碑结束时**产物独立可用、可测、可合并**；严格按依赖顺序推进，不并行开新面。

## 0. 总览

| 里程碑 | 内容 | 交付物 | 用户可见价值 |
|---|---|---|---|
| M1 | `dsh-github` seam | Service Definition 包（类型 + 注册 + 错误） | 无（基建） |
| M2 | `dsh-github-rest` provider | REST provider 包（鉴权/分页/限流/错误映射） | 无（基建） |
| M3 | 只读工具三件套 | `dsh-tool-github`（search / issue_read / pr_read） | **CLI 用户配 `GITHUB_TOKEN` 即可用** |
| M4 | 写工具 + 审批 | issue_create / issue_comment / pr_create | 模型可代用户写 GitHub |
| M5 | `dsh-github-connect` | Device Flow 授权 + flow-state 检测 + `@Remote` 方法 | 一键连接（后端就绪） |
| M6 | `dsh-ui-github` | 连接卡片 + 输入框上方 PR 状态条 | **完整产品体验** |
| M7 | 收尾 | catalog 登记、文档 gate、examples | 可发布 |
| M8 | 审查读侧 | review / review comment 读取 + CI 失败细节 | **模型能看评审意见、能看 CI 为什么红** |
| M9 | 结构化审查 | `github_pr_review` 编排工具 + 维度路由 | AI 审查从一句 prompt 变为有覆盖面的任务 |
| M10 | 审查回写 + 生命周期 | review 提交、PR 更新/指派、merge 前置检查 | 审查结论回到 PR，闭环完成 |

依赖链：M1 → M2 → M3 → M4；M5 依赖 M1/M2（不依赖 M3/M4）；M6 依赖 M5；M7 依赖全部。
M5 可与 M3/M4 并行（如有人力），但默认串行推进。

v2（M8–M10，范围决策见 [ADR-0012](../adr/0012-pr-review-loop-enters-scope.md)）：M8 → M9 → M10 严格串行 —— M9 的证据包依赖 M8 的读形状，M10 的审批门控依赖 M9 产出的 finding 形状。

---

## M1 — `dsh-github` Service Definition

**位置**：`packages/github/github`（host plane）

### 任务

1. 包骨架：`package.json`、`./invariant` 子导出、tsconfig，对齐 `dsh-web` 家族包结构。
2. 类型定义（照 design §4 定稿）：
   - 寻址：`GitHubRepoRef { owner, repo }`、`GitHubItemRef { repo, number, url }`
   - 读形状：`GitHubIssue`、`GitHubPullRequest`（`merged` 一等状态）、`GitHubComment`、`GitHubDiff { files, truncated }`、`GitHubChecksResult`
   - 搜索：`GitHubSearchKind = 'issues' | 'pull-requests' | 'repositories' | 'code'`（闭合联合）
   - 写请求/结果：`GitHubIssueCreateRequest`、`GitHubCommentCreateRequest`、`GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult { pullRequest, created }`
   - diff 预算：`GitHubDiffRequest { maxFiles, maxPatchChars }`
3. `GitHubError extends HarnessError`：开放 string code（`GITHUB_AUTH` / `GITHUB_RATE_LIMITED`(+`retryAfterMs`) / `GITHUB_NOT_FOUND` / `GITHUB_VALIDATION` / `GITHUB_PROVIDER_*` / `GITHUB_ABORTED`）。
4. `ctx.github` 服务：provider 注册（effect + disposer）、执行期解析（每次操作 resolve，不缓存 provider 实例）、无 provider / `available() === false` 时抛 `GITHUB_PROVIDER_*`。
5. diff 截断逻辑放 seam 层（provider 返回全量或已截断均可，seam 统一执行预算并保证 `truncated` 诚实）。
6. invariant：ref 合法性（owner/repo 非空）、预算参数为正整数等。

### 验收（DoD）

- [x] per-file 100% 覆盖率通过
- [x] REAL-composition 测试：注册 fake provider → `ctx.github` 各操作可走通
- [x] 无 provider、provider 不可用、并发注册两个 provider 的行为都有测试锁定
- [x] 截断逻辑单测：`maxFiles` / `maxPatchChars` 边界、`truncated` 标志正确性
- [x] 函数插件无 default export（门槛 §8）

---

## M2 — `dsh-github-rest` Provider

**位置**：`packages/github/github-rest`（host plane）

### 任务

1. `fetch` 直调 REST v3，不引 octokit；`baseURL` 可配（GHES）。
2. 鉴权：credential-ref（默认 `GITHUB_TOKEN`），**每次操作重新 resolve**（换 token 无需重启）；`available()` 只做本地廉价检查（凭据 ref 可解析与否，不打网络）。
3. 端点映射（v1 全集）：
   - 搜索：`GET /search/issues`（issues + PR）、`/search/repositories`、`/search/code`
   - issue/PR 读：`GET /repos/{o}/{r}/issues/{n}`、`/pulls/{n}`、`/pulls/{n}/files`（diff）、评论列表、`/commits/{ref}/check-runs`（checks）
   - 写：`POST /repos/{o}/{r}/issues`、`/issues/{n}/comments`、`/pulls`
4. 分页：Link header 跟随，内部上限（如 10 页）防失控；评论/文件列表聚合。
5. 限流与重试：`403/429 + retry-after / x-ratelimit-reset` → `GITHUB_RATE_LIMITED { retryAfterMs }`，不在 provider 内自动重试（交给调用方/工具层决策）。
6. 错误映射表：401→`GITHUB_AUTH`、404→`GITHUB_NOT_FOUND`、422→`GITHUB_VALIDATION`、AbortSignal→`GITHUB_ABORTED`、其余→`GITHUB_PROVIDER_HTTP`。
7. **幂等 PR 创建**：`createPullRequest` 先 `GET /pulls?head=owner:branch&base=...&state=open`，命中则返回 `{ pullRequest, created: false }`；未命中才 POST；POST 422 "already exists" 兜底再查一次（竞态窗口）。
8. `installSettingsSection` 挂接用户设置（token / baseURL）。

### 验收（DoD）

- [x] keyless snapshot 测试：所有端点用录制的 fixture 响应回放，无 token 可跑
- [x] `*.e2e.ts`：真实 API 冒烟（无 token 自动 skip，`pnpm test:e2e`）
- [x] 限流、401、404、422、abort 的映射各有测试
- [x] 幂等创建的三条路径（已存在 / 新建 / 竞态 422 兜底）全覆盖
- [x] GHES `baseURL` 拼接测试（含尾部斜杠等边界）

---

## M3 — 只读工具三件套（首个可用里程碑）

**位置**：`packages/github/tool-github`（agent preset）

### 任务

1. `github_search`：kind 闭合联合 `switch + assertNever`；结果精简（标题/编号/状态/URL），控制 token 占用。
2. `github_issue_read`：正文 + 评论（分页聚合，评论数上限）。
3. `github_pr_read`：元数据 + 按需子操作（`diff` / `comments` / `checks` 拆开，避免一次拉全）；diff 预算默认值在**工具层**持有（如 `maxFiles: 50` / `maxPatchChars: 60000`），透传给 seam 执行。
4. `presentCall` / `presentResult` 纯函数（session 回放要求），错误呈现友好（限流→"稍后重试"提示 + retryAfter）。
5. preset 注册：`ctx.tools.register(defineTool(...))`；`write` 开关此时只放读工具。

### 验收（DoD）

- [x] snapshot 测试：每个工具的 present 输出定型
- [x] diff 截断在超预算 PR fixture 上验证 `truncated: true` 且提示模型"可缩小范围重查"
- [x] REAL-composition：preset + seam + fake provider 全链路
- [ ] **手工验收**：CLI 配 `GITHUB_TOKEN`，模型可搜索/读 issue/读 PR —— 此里程碑后对外可用。宿主已可获取（`@deepseek-ai/dsh` CLI），且已在真实宿主中验证到 agent 完整装配：四包经 `dsh.bundle` patch 激活为 profile 层、插件装载无错、请求到达 DeepSeek API（假 key 得 403）。剩余步骤仅为配真实 `DEEPSEEK_API_KEY` + `GITHUB_TOKEN` 走模型驱动的搜索/读取（安装步骤见根 README"Installation"）

---

## M4 — 写工具 + 审批联动

### 任务

1. `github_issue_create`、`github_issue_comment`、`github_pr_create` 三工具，受 `write` 开关门控（默认开，可在 preset 配置关）。
2. 接 `tools/pre-execute` 审批流：写操作弹 `ApprovalPanel`，展示目标 repo、标题、正文摘要；拒绝→工具返回被拒结果（不抛异常，模型可继续）。
3. `github_pr_create` 幂等语义在工具层呈现：`created: false` 时 present 为"已有开放 PR #N"而非报错。
4. CLI/headless 降级路径验证：二选一审批可用。

### 验收（DoD）

- [x] 审批通过 / 拒绝 / 超时（cancelled）三条路径测试（另含审批通道缺失、无 agent 可路由两条降级路径）
- [x] `write: false` 时写工具不注册（catalog 里也不出现）
- [x] 幂等重试场景 snapshot（两次 `github_pr_create` 第二次 `created: false`）

---

## M5 — `dsh-github-connect`（Device Flow + flow-state）

**位置**：host plane

### 任务

1. Device Flow：
   - `POST /login/device/code`（只需 client_id）→ 返回 `user_code` / `verification_uri` / `interval`
   - 宿主按 `interval` 轮询 `POST /login/oauth/access_token`，处理 `authorization_pending` / `slow_down`(+5s) / `expired_token` / `access_denied`
   - 成功 → `ctx.credentials.set('GITHUB_TOKEN', ...)` → `credentials/updated` 事件推前端
   - v1 用不过期授权模式（refresh 二期，design §5 已记录空白）
2. `@Remote` 方法（照 `packages/feedback/message-feedback` 全栈模板）：
   - `connectStatus()`：凭据可解析？→ 查 `/user` 拿登录名（带缓存）
   - `startDeviceFlow()` / `pollDeviceFlow()`（或宿主自轮询 + 事件推送，实现时定夺，倾向后者：前端只开窗 + 听事件）
   - `createPr({ title, body, base })`：标题/描述由宿主用会话上下文预填，前端可编辑确认
   - `mergePr({ number, method })`：squash / merge / rebase
3. flow-state 检测：监听 agent 回合结束事件 → 廉价 git 检查（`git rev-list --count base..HEAD`、本回合新提交、head 分支开放 PR 及 CI conclusion）→ 归纳状态机 → `github/flow-state` 事件推前端。状态机四态照 design §2。
4. 门控：remote 非 GitHub 或凭据不可解析 → 不发事件（未连接用户零感知）。
5. CI 徽章刷新：PR 开着时轮询 checks（带退避，页面不可见时暂停——由前端订阅控制）。

### 验收（DoD）

- [x] Device Flow 状态机全路径测试（pending / slow_down / expired / denied / 成功），GitHub 端点全 mock
- [x] flow-state 检测在 fixture git 仓库上测：无领先 / 领先无 PR / PR 开 / PR 合并四态迁移
- [x] 回合结束无新提交时不发事件（防噪声）
- [x] `credentials/updated` 白名单转发验证（Device Flow 成功 → `credentials.set` → 事件广播全链路测试）

---

## M6 — `dsh-ui-github`（React client）

### 任务

1. GitHub 连接卡片（注册 `settings.plugin.item` slot，落在"插件 → 插件配置"页，ADR-0008；实现时以 `GitHubUiShell` 端口的 `settings.section` 名义开发，适配层收窄为卡片）：
   - 未连接：[Connect GitHub] 按钮 → `window.open` 授权页 + user_code 自动复制 + 等待态
   - 已连接：`已连接 @用户名` + [断开]
2. PR 状态条（注册 `conversation.input.dock` slot），三阶段 UI 照 design §1：
   - 阶段 1：`feat/xxx 领先 master 3 个提交` + [创建 PR ▾]（下拉：编辑标题/描述后确认）
   - 阶段 2：`#123 · CI 徽章` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）
   - 阶段 3：`#123 已合并`，短暂展示后自动收起
3. [AI 审查] → `sessions.prompt("审查 PR #N …")`（唯一消耗模型回合的按钮）；[创建 PR] / [Merge] 直调 `@Remote`（零模型回合）。
4. Merge 接现有审批面板做不可逆确认。
5. i18n 配对（中英）；错误态（限流/断网/token 失效）就地提示。

### 验收（DoD）

- [x] 组件测试：四态渲染 + 事件驱动迁移
- [x] 断开连接后状态条立即消失
- [ ] **端到端手工验收脚本**（写进 PR 描述）：连接 → agent 提交 → 状态条出现 → 创建 PR → CI 徽章 → AI 审查 → merge → 收起（适配层已落地：`dsh-ui-github/client` 半侧 + 自带 `cordis.patch.yml`，`dsh plugin add` 即接全链路;事件面按 ADR-0009 为 `credentials/updated` + 轮询。剩余步骤仅为在真实 dsh 宿主里执行脚本本身）

---

## M7 — 收尾与发布

1. [x] `scripts/gen-tool-catalog.ts` boot manifest 登记（工具包硬性门槛）：脚本按 config 变体（default / read-only）真实组合并快照全部注册工具到 `tool-catalog.json`；`pnpm gen:catalog` 再生，`pnpm gate:catalog` 漂移即失败。
2. [x] 双语 README（每包，含 `## Model Experience` 定型章节）+ i18n 校对：五包三件套齐全，i18n 哈希记录与当前 blob 一致。
3. [x] examples 叶子：`examples/github-quickstart`——CLI + token 路径真实可跑（seam 直调、`ctx.tools.execute`、宿主仓库上的 flow-state 检测；keyless 优雅降级），完整 UI 路径以编译校验的接线形态给出（`ui-wiring.ts`，ADR-0007）。配套新增 `pnpm build`（tsc -b + 入口 shim），使脚本与示例经 `lib/` 真实解析各包。
4. [x] 文档 gate 全绿；全仓 typecheck / coverage 复查（仓库未配置独立 lint 工具，以 tsc 严格模式为准——`noUnused*`、`strict` 全开）。
5. [x] 发布清单：全包版本 `0.1.0`、根 `CHANGELOG.md`、design.md 状态更新为"已实现（v1）"、AGENTS.md 项目状态同步。

---

---

# v2 — 审查闭环

> 范围决策：[ADR-0012](../adr/0012-pr-review-loop-enters-scope.md)。design §4.2 是接口单一事实源；本节只写做什么、按什么顺序、验收标准。

## M8 — 审查读侧（review comments + CI 失败细节）

**位置**：`packages/github/github`（新形状）+ `github-rest`（新端点）+ `tool-github`（新 part）

### 任务

1. seam 新增读形状：`GitHubReview`、`GitHubReviewComment`、`GitHubCheckAnnotation`、`GitHubCheckFailure`（design §4.2）。`GitHubReviewComment` 与 `GitHubComment` 保持为两个类型，不合并。
2. provider 新增端点：
   - `GET /repos/{o}/{r}/pulls/{n}/reviews`（review 列表，含 state）
   - `GET /repos/{o}/{r}/pulls/{n}/comments`（行级 review comment，Link 分页聚合）
   - `GET /repos/{o}/{r}/check-runs/{id}/annotations`
   - `GET /repos/{o}/{r}/actions/runs/{id}/jobs` + `GET /repos/{o}/{r}/actions/jobs/{id}/logs`（仅在无 annotation 或显式请求时走）
3. CI 失败取用顺序按 [ADR-0015](../adr/0015-ci-failures-via-annotations-first.md)：annotations 优先，无则取日志**尾部**；只处理 `failure` / `timed_out` / `cancelled` 的 check-run。
4. 日志预算 `maxLogLines` / `maxLogChars` 由工具层持有、seam 单点截断（同 ADR-0005 机制）；先按字符截、再向前对齐行首。
5. `restRequest` 开文本响应分支（日志不是 JSON）；302 重定向到对象存储时**不转发 Authorization 头**。
6. `github_pr_read` 的 part 联合扩展：`metadata | diff | comments` → 增 `reviews`、`ci-failures`；`switch + assertNever` 保持闭合。
7. 错误映射补充：日志过期 410 → `GITHUB_NOT_FOUND`（带可读说明）。

### 验收（DoD）

- [x] per-file 100% 覆盖率；keyless snapshot（新端点全部有录制 fixture）——全仓 337 测试、语句/分支/函数/行四项 100%
- [x] annotations 命中 / 无 annotation 回落日志 / 日志 410 三条路径各有测试
- [x] 日志尾部截断边界：恰好等于预算、单行超预算、行首对齐后为空
- [x] `truncated` 诚实性测试（annotation 分页未穷尽与日志截断都置位；provider 侧已截断的日志向上传播为结果级 `truncated`）
- [x] `github_pr_read` 新 part 的 present 输出 snapshot 定型
- [x] `*.e2e.ts`：真实 PR 上取一次 review comments 与一次失败 CI（无 token 自动 skip）——已写入，**尚未在有 token 的环境实跑**
- [x] `pnpm gate:catalog` 通过（工具 schema 变更已再生）

### 实现注记（与 ADR-0015 的偏差）

ADR-0015「后果」段设想 check-run → workflow job 的关联走 `GET /actions/runs/{id}/jobs`。实现时发现该端点需要 **run id**，而 run id 只能从 check run 的 `details_url` 里取——既然要解析这个 URL，job id 也在同一个 URL 里（`…/actions/runs/{run}/job/{job}`），多打一次请求没有收益。因此实际实现直接从 `details_url` 解析 job id，零额外请求；解析不出（非 Actions 检查、`details_url` 缺失或形状变化）时该 run 就没有日志证据，annotations 不受影响。ADR 不可变，差异记录于此。

## M9 — `github_pr_review` 结构化审查工具

**位置**：`packages/github/github`（编排形状）+ `tool-github`（工具）+ `ui-github`（prompt 文案）

### 任务

1. seam 新增 `GitHubReviewDimension` 闭合联合与 `GitHubReviewBrief` / `GitHubReviewDimensionBrief`（design §4.2）。
2. **维度路由**（确定性，宿主侧）：由改动文件路径与 diff 特征推导适用维度 —— 未改测试文件不下发 `tests`，未改类型声明不下发 `types`，diff 无 `catch` / 错误分支不下发 `error-handling`。规则表与判定函数纯函数化，可完整单测。
3. **分维度证据包**：每维度只带该维度需要的 diff 切片，不重复全量 diff；预算参数独立于 `github_pr_read`，默认值在本里程碑定并写入代码注释与包 README。
4. **审查契约**：每维度的 checklist + 严重度口径（`blocker` / `major` / `minor` / `nit`）+ 输出格式要求（每条 finding 带 `path:line`、问题陈述、依据、建议）。契约文本是常量，不由配置注入。
5. 注册 `github_pr_review`（只读工具，不受 `write` 开关门控）；`presentCall` / `presentResult` 纯函数。
6. `dsh-ui-github` 的 `reviewPrompt` 改写为引导模型调用 `github_pr_review`；中英 i18n 配对同步，**不引导提交 review**（ADR-0014）。

### 验收（DoD）

- [x] 维度路由单测：给定文件清单 → 期望维度集合（含全命中、全不命中、单维度三类）
- [x] 证据包不重复全量 diff 的断言（brief 持有 diff 的**同一引用**，维度只列 paths；渲染层断言同一 hunk 只出现一次）
- [x] 超预算 PR fixture 上 `truncated: true` 且提示模型该审查"知情地不完整"
- [x] 工具 present 输出 snapshot；维度联合在 seam 与工具两侧都是闭合集合
- [x] REAL-composition：preset + seam + fake provider 跑通一次完整 brief
- [x] i18n 配对哈希一致；`pnpm gate:catalog` 通过

### 实现注记（与 ADR-0013 措辞的偏差）

ADR-0013 举的路由例子是"没改测试就不发 `tests` 维度的空壳任务"。实现时按其**意图**（不下发空壳）而非字面执行：`tests` 维度在**有任何可执行代码改动**时就适用——要么审新测试的质量，要么追问"这处改动为什么不需要测试"。后者恰恰是测试审查最有价值的产出，按字面规则会被丢掉。真正被剔除的是纯文档 PR：它既不发 `tests`，也不发 `types` / `correctness` / `simplification`。

同理，`correctness` 与 `simplification` 搭任何代码改动都适用。路由的价值在于**剔除**不相关维度，而非把六个维度平均分配——这一点在 `routeDimensions` 的文档注释里也写明了。

## M10 — 审查回写 + PR 生命周期

**位置**：`packages/github/github` + `github-rest` + `tool-github` + `github-connect`（merge 前置检查）

### 任务

1. seam + provider：`POST /repos/{o}/{r}/pulls/{n}/reviews`（`GitHubReviewSubmitRequest`）、`PATCH /pulls/{n}`、`POST /pulls/{n}/requested_reviewers`、`PUT|POST /issues/{n}/labels`、`GET /pulls`（列表）、`readMergeability`。
2. 工具 `github_pr_review_submit`：
   - preset 开关 `reviewVerdicts`，**默认 `false`**；为 `false` 时 event 联合只有 `COMMENT`（schema 层收窄，非运行期拒绝）
   - `write: false` 时与其他写工具一并不注册
   - `APPROVE` / `REQUEST_CHANGES` 走强制勾选确认（`RiskConfirmation`），摘要含 event、目标 PR、inline 评论条数、正文摘要；`COMMENT` 走普通审批面板
3. 工具 `github_pr_update`（title / body / base / draft→ready / state）、`github_pr_assign`（reviewer / assignee / label）、`github_pr_list`；均受 `write` 开关门控（`github_pr_list` 除外）。
4. `github-connect` 的 `mergePr` 增前置 `readMergeability`：不可合并时不发 `PUT /merge`，返回结构化原因供状态条就地提示；i18n 配对补文案。
5. 错误映射：approve 自己创建的 PR 的 422 → 对模型可读的说明（"不能批准自己创建的 PR"）。

### 验收（DoD）

- [ ] `reviewVerdicts` 两种取值下的工具 schema 各有 snapshot（锁定默认值不被无声改动）
- [ ] 审批通过 / 拒绝 / 取消三路径 × `COMMENT` 与 `APPROVE` 两种确认形态
- [ ] 自审 422 映射测试
- [ ] merge 前置检查：可合并 / 冲突 / 必需检查未过 三态，且不可合并时确实没有发出 `PUT`
- [ ] `gen-tool-catalog.ts` config 变体扩展（default / read-only / verdicts-on）后 `pnpm gate:catalog` 通过
- [ ] 每包双语 README 的 `## Model Experience` 章节同步新工具；i18n 配对哈希一致
- [ ] **手工验收**：在真实仓库的他人 PR 上走通"读评审意见 → `github_pr_review` → 提交 `COMMENT` review"

---

## 风险与预案

| 风险 | 影响 | 预案 |
|---|---|---|
| 凭据 seam 只存单字符串，Device Flow 未来要存 refresh_token | M5 | v1 用不过期授权；结构化 token 序列化为 JSON 字符串的方案先在 M5 里留注释占位，不实现 |
| `credentials.set` 钉死 loopback，远程 Web UI 不可用 | M5/M6 | 明确文档化为已知约束；不在本项目解决 |
| search API 限流（30 req/min，远低于 core API） | M3 | `github_search` 结果精简 + 限流错误引导模型改用直接读取 |
| `checks` 轮询打爆 rate limit | M5 | 退避轮询 + 前端不可见即停订阅 |
| dsh slot API（`conversation.input.dock`）演进 | M6 | M6 开工前重新核对 dsh 主仓 slot 契约，发现变化先改设计再动工 |
| PR 创建竞态（幂等兜底路径少测） | M2 | 422 兜底路径单独 fixture 锁定 |
| Actions 日志体积不可控，302 到对象存储的转发行为未实测 | M8 | annotations 优先（ADR-0015）；日志只取尾部且强预算；重定向不带 Authorization 头，e2e 上实测一次 |
| check-run ↔ workflow job 的 id 关联多一次请求，可能不划算 | M8 | 实测后若成本不可接受，退化为"仅显式请求日志时才走该链路"（ADR-0015 已记预案） |
| 维度路由规则过拟合本仓库的文件布局 | M9 | 规则表纯函数化 + 用三个风格不同的真实 PR fixture 交叉验证；宁可漏判维度也不误发空壳任务 |
| 审查证据包体积超出模型上下文 | M9 | 独立预算 + 分维度切片（不重复全量 diff）；`truncated` 诚实并提示缩小范围 |
| `reviewVerdicts` 默认值被后续改动无声翻转 | M10 | 两种取值各有 schema snapshot；catalog 变体覆盖 verdicts-on |
| 以用户身份 approve 造成不可逆社会后果 | M10 | 双层门控（ADR-0014）：能力开关默认关 + 强制勾选确认 |

## 工程门槛核对清单（每包合并前）

- [ ] `./invariant` 子导出
- [ ] per-file 100% 覆盖率
- [ ] REAL-composition 测试
- [ ] keyless snapshot（无 token 可跑全量测试）
- [ ] `*.e2e.ts` 无 token 自动 skip
- [ ] 函数插件无 default export
- [ ] 双语 README + i18n 配对
- [ ] 可选服务用 `ctx.get('credentials')`，注册即 effect
