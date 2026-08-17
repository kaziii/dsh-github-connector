# dsh-tool-github

[English](README.md) | 中文

基于 [`dsh-github`](../github/README.zh.md)（`ctx.github`）的**面向模型的 `github_*` 工具套件**。本包拥有 schema、校验、提示词指引、工具层预算与呈现——绝不涉足 provider、传输或凭据。

| 工具 | 作用 |
|---|---|
| `github_search` | 搜索 issues / pull-requests / repositories / code（闭合 kind 联合）。精简结果：`owner/repo#N [state] title` + URL。 |
| `github_issue_read` | 标题、状态、标签、正文，外加封顶的聚合评论。 |
| `github_pr_read` | 拆分为按需 part：`metadata`（默认）/ `diff` / `comments` / `reviews` / `checks` / `ci-failures`——一次调用绝不为模型没要的数据付费。 |
| `github_pr_review` | 为一个 PR 组装结构化审查任务：diff（只出现一次）、适用于本次改动的维度、每个维度的 checklist、严重度口径、finding 契约。给的是证据与契约，不是裁决（ADR-0013）。 |
| `github_pr_list` | 列出仓库的 PR，可按状态与 head/base 过滤。只读。 |
| `github_issue_create` | 写操作，审批门控。 |
| `github_issue_comment` | 写操作，审批门控。 |
| `github_pr_create` | 写操作，审批门控，幂等（同 head/base 已有开放 PR 是正常答案，不是错误）。 |
| `github_pr_review_submit` | 写操作，审批门控。提交带行级评论的审查。`APPROVE` / `REQUEST_CHANGES` 只在 `reviewVerdicts` 打开时存在（ADR-0014）。 |
| `github_pr_update` | 写操作，审批门控。标题、正文、base 分支、开/关状态。 |
| `github_pr_assign` | 写操作，审批门控。指派 reviewer、应用 label。 |

## 配置

| 字段 | 默认值 | 语义 |
|---|---|---|
| `write` | `true` | 注册三个写工具。关闭后它们完全不出现在工具目录里。 |
| `searchMaxResults` | `8` | 每次搜索的命中上限（search API 限流预算稀缺：30 次/分钟）。 |
| `maxComments` | `30` | 每次读取返回的评论上限。 |
| `diffMaxFiles` / `diffMaxPatchChars` | `50` / `60000` | **工具层持有**的 diff 预算（ADR-0005）：此处持有、传给 seam、由 seam 执行。 |
| `logMaxLines` / `logMaxChars` | `80` / `8000` | **工具层持有**的 CI 日志预算，机制同上。只作用于日志**尾部**（ADR-0015）。 |
| `reviewMaxFiles` / `reviewMaxPatchChars` | `60` / `120000` | **工具层持有**的审查 brief 预算。刻意不复用上面的 diff 预算：审查读的范围比普通 diff 读更宽（ADR-0013）。 |
| `reviewVerdicts` | `false` | `APPROVE` / `REQUEST_CHANGES` 是否存在。默认关（ADR-0014）——见下节。 |
| `timeoutMs` | `30000` | 挂到每个工具上的协作式超时（由 `dsh-timeout-policy` 执行）。 |

## 审查裁决默认关闭（ADR-0014）

提交审查是本包第一个带**社会后果**的操作：`APPROVE` 与 `REQUEST_CHANGES` 以用户本人的账号发出，在协作者眼里就是用户的判断，并且会改变 PR 是否被阻塞。对这种操作，"每次弹审批"是错误的最后防线——在审批疲劳下，一次走神的"是"就够了。

所以能力本身是 opt-in 的。`reviewVerdicts` 关闭时（默认），event 枚举里只有 `COMMENT`：模型根本看不到"可以批准"这件事，也就无从尝试、无从被拒。打开开关才会加宽枚举，而每次提交仍然要过审批流，理由里会点明 event 及其后果。

两点值得知道：

- GitHub 不允许对**自己创建的** PR 执行 `APPROVE` 与 `REQUEST_CHANGES`。状态条 [AI 审查] 恰恰就是这种场景，因此它只可能产出 `COMMENT` —— provider 会把平台那句干巴巴的 422 翻译成人话。
- 宿主的 `PreToolDecision` 只带一个 reason 字符串，没有可提升的风险级别，所以那段 reason 的措辞**就是**这里能有的全部确认层。详见执行计划的 M10 实现注记。

## 审批流（写操作）

每个写操作在 `tools/pre-execute` 返回 `ask`，附带人类可读的理由——目标 repo、标题、正文摘要——正是宿主 ApprovalPanel 渲染的内容。注册表经可选审批 seam 解析该 ask：`allowed-once` 放行；拒绝、取消、审批通道缺失各自物化为不同的模型可见拒绝结果（绝不抛异常），模型可以解释并继续。读工具原样通过闸门。

## 呈现

`presentCall` / `presentResult` 是纯函数、回放安全：读呈现为 `read`/`search` 卡片，写呈现为 `edit` 卡片；`github_pr_create` 把 `created: false` 呈现为 "PR #N already open"。结果 meta 防御性收窄——畸形的回放 meta 回退到通用卡片而不是抛错。

## 模型可行动的错误

seam 失败在工具边界翻译：限流变为携带 `retryAfterMs` 的等待重试提示（并引导改用直接读取而非搜索），鉴权失败点名修复方式（连接 GitHub / 设置 `GITHUB_TOKEN`），not-found 指向 handle 本身。diff 截断附带"缩小范围"提示。

## Model Experience

模型看到六个 schema 严格而小巧的工具；在搜索命中与读取之间流转的可移植 `owner/repo` + `number` handle；为 token 开销调校的精简文本渲染；诚实的截断标记与恢复提示；以及被措辞为"答案"的写拒绝。系统提示词区块预先教会模型 part 拆分的 PR 读取与审批语义。

`github_pr_review` 是唯一一个交给模型**任务形状**而非数据的工具。被要求"审查这个 PR"时，放任模型自己发挥的结果是：读一遍 diff 然后即兴发挥，覆盖面每次都不一样，严重度全凭当下感觉，findings 落不到具体行上。这个工具用一份 brief 取代那种即兴：维度是**由改动本身确定性路由**出来的——纯文档 PR 永远不会被问类型设计——每个维度带 checklist，另有一套固定的严重度词汇和每条 finding 必须满足的契约。它不给裁决也不打分：被保证的是覆盖面与形状，判断仍然归模型（ADR-0013）。

有两个 part 的存在是为了让模型能闭合一条回路，而不只是旁观。`part=reviews` 同时返回裁决与行级评论——渲染为 `path:line · author (side): body`，可直接据以修改，这是 issue 级评论串做不到的。行号已失效（outdated）的评论改带 diff hunk，因为那是它仅剩的锚点。`part=ci-failures` 回答检查为什么失败：CI 工具报了结构化 annotation 就用它，否则取受预算约束的日志**尾部**——绝不取头部，因为失败信息总在末尾。两者都没有时，模型会被明确告知，而不是拿到一个空块。
