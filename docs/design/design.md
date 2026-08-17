# dsh GitHub 连接器 — 设计文档

> 状态：v1（M1–M7）已实现；v2「审查闭环」（范围决策见 [ADR-0012](../adr/0012-pr-review-loop-enters-scope.md)）：M8–M10 全部已实现（审查读侧 / 结构化审查 / 审查回写与生命周期），v2 闭环完成；仅 M10 的真实仓库手工验收挂起。本文档是与 dsh 仓库调研结论一起沉淀的完整方案，随实现演进；客户端外壳的对接方式见 [ADR-0007](../adr/0007-ui-binds-client-shell-via-port.md)，依赖 dsh 宿主环境的两项手工验收仍挂起（见[执行计划](../plans/execution-plan.md) M3/M6）。
> v3「跨机器同步」（范围决策见 [ADR-0016](../adr/0016-config-sync-via-github-repo.md) 与 [ADR-0017](../adr/0017-session-sync-readonly-with-fork-continuation.md)）：设计定稿、未开工 —— 配置同步（M11）与 session 同步（M12），载体是用户账号下的私有仓库、传输走 git 协议（**不是** §10 仍排除的 contents API）。
> 实施拆解见[执行计划](../plans/execution-plan.md)；关键取舍的决策记录见 [ADR](../adr/README.md)。

## 1. 目标与产品体验

让 dsh 用户以最低心智负担把 GitHub 接入 agent 工作流：

1. **一键连接**：设置页点击 "Connect GitHub" → 浏览器打开 GitHub Device Flow 授权页 → 授权完成后 dsh 显示"已连接 @用户名"。全程不接触 token 明文、不编辑配置文件。
2. **对话内 PR 工作流**：agent 完成阶段性工作（有新提交）后，输入框上方自动出现状态条：
   - **阶段 1**（分支领先 base，无 PR）：`repo feat/xxx +N −M` 紧凑胶囊条 + [创建 PR]（单击派发 agent 创建并 loading，ADR-0011）+ [×]（收起至状态变化）
   - **阶段 2**（PR 已开）：`#123 · CI 通过` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）
   - **阶段 3**（已合并）：`#123 已合并到 master`，短暂确认后收起
3. **模型侧工具**：搜索、读 issue/PR（diff 带 token 预算）、建 issue/评论/PR，写操作走 dsh 现有审批流。
4. **跨机器同步（v3，默认关）**：连接卡片上开启后，dsh 配置随 GitHub 账号走；另一台机器上的 session 可发现、可浏览、可 fork 续聊（§4.3）。

**门控**：状态条仅在「当前项目 git remote 指向 GitHub 且凭据可解析」时出现；未连接用户对该功能无感知。同步能力始终 opt-in，dsh 核心不依赖它（ADR-0016）。

## 2. 关键机制：确定性的"阶段性成功"检测

不靠 AI 判断任务是否完成。宿主监听 agent 回合结束事件，跑廉价 git 检查：

- 当前分支是否领先 base（`git rev-list --count base..HEAD`）
- 本回合是否产生了新提交
- 该 head 分支是否已有开着的 PR、PR 状态与 CI conclusion

归纳为状态机供前端取用（宿主内部 `github/flow-state` 事件；浏览器侧由前端持节奏轮询 `refreshFlowState` 获得，dsh 不转发自定义宿主事件，ADR-0009）：

```
未连接 / 非 git 仓库 / 无领先  →  隐藏
领先且无 PR                    →  可创建 PR
PR 已开                        →  可审查 / 可合并（CI 徽章实时）
PR 已合并                      →  确认后收起
```

零 token 成本；git 状态是客观信号，不会出现"AI 觉得完成了但没提交"的误报。

## 3. 包结构（dsh capability seam 三角色）

| 包 | 位置 | 角色 |
|---|---|---|
| `dsh-github` | packages/github/github（host） | **Service Definition**：`ctx.github`、规范化词汇、provider 注册（effect + disposer）、执行期 provider 解析、`GitHubError` |
| `dsh-github-rest` | packages/github/github-rest（host） | **Provider**：fetch 直调 REST v3（不引 octokit）、credential-ref 鉴权、`baseURL` 支持 GHES、`installSettingsSection` 接入用户设置 |
| `dsh-tool-github` | packages/github/tool-github（agent preset） | **Consumer**：`ctx.tools.register(defineTool(...))` 注册模型工具，`write` 开关（v2 增 `reviewVerdicts` 开关，默认关，ADR-0014） |
| `dsh-github-connect` | host | Device Flow 授权 + git flow-state 检测 + `@Remote` 方法（`createPr` / `mergePr` / `connectStatus`）供前端按钮直调 |
| `dsh-github-sync` | packages/github/github-sync（host） | **v3**：配置与 session 的跨机器同步（ADR-0016 / 0017）。自持注入式 git runner（不复用 `dsh-github-connect` 的私有 helper）；session 侧经 `SessionSyncPort` 收口，不让 git 语义外泄到上层 |
| `dsh-ui-github` | client（React） | "插件 → 插件配置"页 GitHub 连接卡片（注册 `settings.plugin.item` slot，ADR-0008）+ 输入框上方 PR 状态条（注册 `conversation.input.dock` slot）；v3 在连接卡片内增同步开关与远端 session 浏览入口 |

组合分层：Service Definition + Provider 进 host 组合（bundle patch），tool 进 agent preset —— 与 dsh web 家族"服务在宿主、工具在 preset"一致。

## 4. Service Definition 接口

### 4.1 v1 核心类型（已实现）

核心类型（完整草案见评审记录，风格对齐 `dsh-web`）：

- 寻址：`GitHubRepoRef { owner, repo }`、`GitHubItemRef { repo, number, url }`（number+repo 是模型在工具间传递的可移植 handle）
- 读形状：`GitHubIssue`、`GitHubPullRequest`（`merged` 是一等状态；diff 与 checks 拆成独立按需操作）、`GitHubComment`、`GitHubDiff { files, truncated }`、`GitHubChecksResult`
- 搜索：`GitHubSearchKind = 'issues' | 'pull-requests' | 'repositories' | 'code'`（闭合联合，消费端 `switch + assertNever`）
- 写：`GitHubIssueCreateRequest`、`GitHubCommentCreateRequest`、`GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult { pullRequest, created }`（**幂等**：同 head/base 已有开放 PR 时返回既有 PR，`created: false`）
- Provider：单 provider 拥有全部操作（读写拆开会让身份/鉴权产生分歧）；`available()` 只做本地廉价检查
- 错误：`GitHubError extends HarnessError`，开放 string code：`GITHUB_AUTH`、`GITHUB_RATE_LIMITED`（带 `retryAfterMs`）、`GITHUB_NOT_FOUND`、`GITHUB_VALIDATION`、`GITHUB_PROVIDER_*`、`GITHUB_ABORTED`
- diff 预算：`GitHubDiffRequest { maxFiles, maxPatchChars }` 由 consumer 层持有、seam 统一执行截断，`truncated` 永远诚实

### 4.2 v2 审查闭环扩展（设计定稿，未实现）

范围决策见 [ADR-0012](../adr/0012-pr-review-loop-enters-scope.md)。三段各自的新形状：

**读侧（M8，已实现）**

- `GitHubReview { id, author, state, body?, submittedAt }`，`state` 为闭合联合 `'commented' | 'approved' | 'changes-requested' | 'dismissed' | 'pending'`
- `GitHubReviewComment { id, path, line?, side, diffHunk?, body, author, createdAt, inReplyToId? }` —— 与 `GitHubComment`（issue 级）**是两个类型**，不合并：前者锚在代码行上，后者锚在 PR 上，模型对二者的处理方式不同
- `GitHubCheckAnnotation { path, startLine?, endLine?, level, message, title? }`
- `GitHubCheckFailure { run, annotations, log? }`，`log: { text, truncated }` —— 取用顺序与预算见 [ADR-0015](../adr/0015-ci-failures-via-annotations-first.md)
- 操作（落地名）：`getReviews`、`getReviewComments`、`getCheckFailures(item, request)`，与既有 `getIssue` / `getDiff` 命名一致
- job 日志的定位从 check run 的 `details_url` 解析 job id（零额外请求），而非 ADR-0015 设想的 `/actions/runs/{id}/jobs`——理由见[执行计划 M8 实现注记](../plans/execution-plan.md)

> `resolved` / 线程折叠状态只有 GraphQL 有，REST 拿不到；v2 不提供该字段（GraphQL 仍在 §10 排除项内）。

**编排侧（M9，已实现）**

- `GitHubReviewDimension = 'correctness' | 'tests' | 'error-handling' | 'types' | 'comments' | 'simplification'`（闭合联合，消费端 `switch + assertNever`）
- `GitHubReviewBrief { pullRequest, diff, dimensions, severityScale, outputContract, truncated }`，每个 `GitHubReviewDimensionBrief { dimension, reason, paths, checklist }`
- **diff 只在 brief 里出现一次**，维度用 `paths` 引用它而不复制 patch —— 六个维度覆盖一份 diff 必须只花一份 diff 的 token。严重度口径与输出契约同理，全局各一份而非每维度重复
- 维度路由（哪些维度适用于本 PR）是**确定性规则**，由改动文件路径与 diff 变更行特征推导（只看 `+`/`-` 行，不看上下文行），放在宿主；判断归模型（[ADR-0013](../adr/0013-structured-review-as-evidence-orchestrator.md)）
- 落地名：seam 上是 `buildReviewBrief(item, request)`；纯函数 `classifyFile` / `changedLines` / `routeDimensions` 单独导出，无需 provider 即可测
- 预算独立于 `github_pr_read`（`reviewMaxFiles` / `reviewMaxPatchChars` = `60` / `120000`），不复用其默认值

**写侧（M10，已实现）**

- `GitHubReviewSubmitRequest { item, event, body?, comments? }`，`event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'`；`comments` 为 `{ path, line, side?, body }[]`，seam 校验锚点（路径非空、行号为正整数）
- `APPROVE` / `REQUEST_CHANGES` 受 preset 开关 `reviewVerdicts`（默认 `false`）门控，关闭时 event 枚举在 **schema 层**就只有 `COMMENT`（[ADR-0014](../adr/0014-review-verdicts-gated-behind-explicit-opt-in.md)）。该 ADR 设想的"强制勾选确认"无法落地，退化为 reason 文本——原因见[执行计划 M10 实现注记](../plans/execution-plan.md)
- PR 生命周期：`updatePullRequest`（title / body / base / state）、`requestReviewers`、`setLabels`（add / set）、`listPullRequests`（seam 层封顶）
- **draft→ready 不支持**：REST 改不了 draft 状态（只有 GraphQL 的 `markPullRequestReadyForReview`，而 GraphQL 仍在 §10 排除项内）
- `getMergeability(item) → { mergeable?, state, blockedBy }`：`mergePr` 的前置检查，不可合并时**不发 `PUT /merge`**，把 `blockedBy` 交给状态条就地提示
- 错误映射补充：approve 自己创建的 PR 返回 422，改写为对模型可读的说明而非裸 `GITHUB_VALIDATION`；Actions 日志过期返回 410，映射为 `GITHUB_NOT_FOUND`

### 4.3 v3 跨机器同步（设计定稿，未实现）

范围决策见 [ADR-0016](../adr/0016-config-sync-via-github-repo.md)（配置）与 [ADR-0017](../adr/0017-session-sync-readonly-with-fork-continuation.md)（session）。授权不变：Device Flow 默认请求的 `repo` scope 已覆盖私有仓库的创建与推送，同步不新增任何权限。

**载体与仓库布局**

用户账号下的私有仓库（默认名 `dsh-sync`），传输走 **git 协议**（天然增量、非快进即冲突检测、不计入 REST 配额）；token 经 `git -c http.extraHeader=` 传入，不写进 `.git/config`。布局：

```
config/settings.yaml
config/profiles/<name>/{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml}
sessions/<owner>/<repo>/session-<id>/…
```

session 按 **repo remote（`owner/repo`）而非本地绝对路径**分桶：同一项目在两台机器上的不同 checkout 路径由此对齐。这是本连接器独有的可用信息（ADR-0017）。

**配置同步（M11）**

- 同步集是**白名单常量**，不可由用户配置扩展：`settings.yaml` + 各 profile 的四个源文件（`cordis.yml` / `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml`）
- 无条件排除：`.credentials.yaml`（凭据永不同步）、`node_modules`（1.7 MB 平台相关产物）、`storages/` 下的缓存
- 同步的是 profile 的**源**而非产物，新机落地后需一次 `pnpm install` 重建

**session 同步（M12）**

能力边界由实测锁定（探针输出见 ADR-0017）：

| 能力 | 状态 | 依据 |
|---|---|---|
| 发现远端 session | 支持 | `list()` 跨 cwd 返回 |
| 只读浏览完整历史 | 支持 | `inspect()` 通且不提交崩溃修复 |
| fork 续聊 | 支持 | 本机 cwd 生效、血缘保留、seq 连续、父日志未动 |
| 原地接管（同 id 继续写） | **不支持** | `id collision`（persisted cwd ≠ live cwd） |

- fork 走 `sessions.create(新 id, { seed, meta: { cwd: 本机, parentSession: 源 id, seedLength } })`。**不能用内置 `sessions.fork()`** —— 它继承源 session 的 cwd（`packages/core/session/src/index.ts:1090`），跨机器场景下 fork 出来仍是源机路径
- dsh 在种子之后自动插入 `session/end-seed` 事件，UI 据此渲染"以上为继承自另一台机器的历史"分隔线
- 上行默认关闭，以 workspace 为粒度显式 opt-in（session 含完整对话与命令输出）
- GitHub 特有部分关在 `SessionSyncPort` 后面，端口声明 `supportsBidirectionalResume: false` —— 能力声明式，照 dsh `session-persistence` 的 `supportsRawArtifacts` 风格，为将来 dsh 主仓的通用同步 seam 留形状（ADR-0017 决策 5，做法沿用 ADR-0007）

## 5. 认证：GitHub Device Flow

选 Device Flow 而非标准 OAuth 回调，因为：

- dsh webserver 端口可配置甚至 `port: 0`（OS 分配），而 OAuth App 的 redirect_uri 必须预注册固定值
- Device Flow 只需 client_id（无 secret），适合本地分发的开源工具

流程：`POST /login/device/code` → 前端 `window.open` 授权页（user_code 自动复制）→ 宿主按 `interval` 轮询 `POST /login/oauth/access_token` → 拿到 token 后 `ctx.credentials.set('GITHUB_TOKEN', ...)` → `credentials/updated` 事件推给前端刷新状态（该事件在 dsh 转发名单内；等待授权期间前端轮询 `connectStatus`，ADR-0009）。

已知空白（二期）：凭据 seam 无"过期→刷新"钩子；GitHub 用户 token（`ghu_`）默认 8 小时过期。v1 用不过期授权模式绕过，refresh 机制后补。

CLI/headless 路径保持可用：直接配 `GITHUB_TOKEN` 环境变量或 `.credentials.yaml`，provider 每次操作重新 resolve（换 token 无需重启）。

## 6. 按钮通路（"智能感"的来源）

| 按钮 | 通路 | 是否消耗模型回合 |
|---|---|---|
| 创建 PR | `sessions.prompt("创建 PR …")`，模型经 GitHub 工具归纳标题/描述并创建（ADR-0011；`createPr`/`prDraft` @Remote 保留供集成方） | 是（有意取舍） |
| Merge | `ctx.remote.github.mergePr`，接现有审批面板做不可逆确认 | 否 |
| AI 审查 | `sessions.prompt("审查 PR #N …")`，正常 agent 回合 | 是（这正是目的） |

M9 起 [AI 审查] 的 prompt 已改为引导模型调用 `github_pr_review`（ADR-0013），按钮通路本身不变 —— 仍是 `shell.prompt`，不新增直连宿主的路径。该 prompt **不引导模型提交 review**：产出停在会话里，是否回写 GitHub 由用户下一句话决定（ADR-0014）。状态条自审场景永远拿不到 `APPROVE` —— GitHub 禁止批准自己创建的 PR。

## 7. dsh 基建依赖清单（调研结论）

全部现成、无需改 core：

- `ctx.webServer.register`：exact 路由（如需回调；Device Flow 下可不用）
- `ctx.credentials.set/resolve` + `credentials/updated` 事件转发白名单
- `ctx.tools.register(defineTool)` + `presentCall/presentResult`（纯函数，session 回放要求）
- `tools/pre-execute` 审批流 + `ApprovalPanel`（写操作确认）
- client slot 系统：`settings.plugin.item`（连接卡片，ADR-0008）、`conversation.input.dock`、`tool.call.toolview`
- Typert Remote（`@Remote` 方法，前端直调宿主）；全栈模板：`packages/feedback/message-feedback`
- `sessions.prompt`（按钮触发模型回合）

`GitHubUiShell` 端口（ADR-0007）→ dsh 真实 API 映射（源码核实于 `D:\deepseek-harness`，ADR-0008）：

| 端口成员 | dsh 真实落点 |
|---|---|
| `registerSlot('settings.section')` | `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name, id: 'github', locale, inject }, Card))`（入口收窄为卡片） |
| `registerSlot('conversation.input.dock')` | 同上，`name: 'conversation.input.dock'`；模板 `packages/client/ui-goal/src/client/index.ts` |
| `prompt(text)` | `ctx.sessions.scope(sessionId).conversation.send(text)` |
| `copyText(text)` | `writeClipboard` / `useCopyFeedback`（`@deepseek-ai/dsh-client-ui-primitives`） |
| `confirmIrreversible(question)` | `RiskConfirmation` 组件（强制勾选确认，同包） |
| `openExternal(url)` | 无命令式服务；组件渲染安全锚点 `<a target="_blank" rel="noopener noreferrer">`（仅 http(s)），端口成员在适配落地时收敛 |
| `visibility` | 浏览器 `document.visibilitychange`（适配层自持） |
| Typert Remote 客户端面 | 宿主 `TypertRemoteService` + `@Remote()`；client 半侧 `ctx.remote.$mount` 自行挂载（源码级验证通过：宿主无命名空间白名单，挂载无阶段限制，ADR-0009 上下文）。contribution 先手写 strict 描述符（codec 只需 `.parse`），dsh generator 构件后补。事件订阅面仅 `'credentials/updated'`（dsh 不转发自定义宿主事件，其余状态走轮询，ADR-0009） |

client 半侧形态：package.json `exports["./client"]` + `dsh.client.{inject, platform:"web"}` 双向一致，node 半侧空 `apply`；client 包间禁止 value import，跨插件走 cordis service。token 只走 credentials 域，不进 apiproxy `WEB_SETTINGS_NAMESPACES` 白名单。

已知约束：

- 按钮体验为 Web 界面专属；CLI/ACP 降级为文本卡片 + 二选一审批（dsh 呈现体系的既有设计）
- `credentials.set` 钉死 loopback；远程 Web UI 场景需等 dsh 出现真正的认证层
- 凭据 ref 只能存单个字符串值；OAuth 的结构化 token（refresh_token 等）需序列化或等 seam 演进

## 8. 工程约定（dsh 仓库门槛）

- 每包：`./invariant` 子导出、per-file 100% 覆盖率、REAL-composition 测试、keyless snapshot、`*.e2e.ts`（无 token 自动 skip）
- 函数插件**禁止 default export**（Loader 会丢 inject，有 postmortem）
- 工具包必须登记 `scripts/gen-tool-catalog.ts` boot manifest
- 双语 README（`## Model Experience` 定型章节）+ i18n 配对
- 可选服务用 `ctx.get('credentials')`，注册即 effect

## 9. 实施顺序

1. `dsh-github` seam + types + invariant
2. `dsh-github-rest`：认证 / 分页 / 限流（retry-after）/ 错误映射
3. 只读工具三件套 + snapshot 测试（此时 CLI 用户已可用）
4. 写工具 + 审批联动
5. `dsh-github-connect`：Device Flow + flow-state 检测
6. `dsh-ui-github`：连接卡片 + PR 状态条
7. 收尾：catalog 登记、文档 gate、examples 叶子

v2（审查闭环，ADR-0012）：

8. 审查读侧：review / review comment 读取 + CI 失败细节（ADR-0015）
9. `github_pr_review` 编排工具 + 维度路由（ADR-0013）
10. 审查回写 + PR 生命周期 + merge 前置检查（ADR-0014）

v3（跨机器同步，ADR-0016 / 0017）：

11. 配置同步：私有仓库载体 + 白名单同步集 + git 协议传输
12. session 同步：只读下行（发现 / 浏览）+ fork 续聊 + `SessionSyncPort`

## 10. 未纳入

**v1 未纳入、v2 已纳入**：PR review（读评审意见、结构化审查、approve / request changes 回写）—— 由 [ADR-0012](../adr/0012-pr-review-loop-enters-scope.md) 移入，设计见 §4.2。

**v2 未纳入、v3 已纳入**：跨机器同步（dsh 配置 + session）—— 由 [ADR-0016](../adr/0016-config-sync-via-github-repo.md) 与 [ADR-0017](../adr/0017-session-sync-readonly-with-fork-continuation.md) 移入，设计见 §4.3。注意 v3 的传输走 **git 协议**，与下方仍排除的 contents API 不是一回事。

**仍未纳入**：merge queue、分支/文件内容读取（与 fs/web seam 职责重叠，需单独讨论；PR 模板 `.github/pull_request_template.md` 属此项，由 agent 用 fs 工具自行读取，连接器不开 contents API）、reactions、GraphQL（连带 review 线程 `resolved` 状态、suggested changes）、token 自动刷新。

v3 相关的两项也明确不做：**session 原地接管**（在另一台机器上以同一 id 继续写入 —— ADR-0017 实测为 `id collision`，且与并发控制无关）、**事件级同步与通用同步 seam**（能解锁双向续聊，但需要提供写者互斥的后端服务，且定义可同时容纳文件级与事件级的 seam 属 dsh 主仓职责，不是 GitHub 连接器该做的事）。
