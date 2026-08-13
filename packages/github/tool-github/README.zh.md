# dsh-tool-github

[English](README.md) | 中文

基于 [`dsh-github`](../github/README.zh.md)（`ctx.github`）的**面向模型的 `github_*` 工具套件**。本包拥有 schema、校验、提示词指引、工具层预算与呈现——绝不涉足 provider、传输或凭据。

| 工具 | 作用 |
|---|---|
| `github_search` | 搜索 issues / pull-requests / repositories / code（闭合 kind 联合）。精简结果：`owner/repo#N [state] title` + URL。 |
| `github_issue_read` | 标题、状态、标签、正文，外加封顶的聚合评论。 |
| `github_pr_read` | 拆分为按需 part：`metadata`（默认）/ `diff` / `comments` / `checks`——一次调用绝不为模型没要的数据付费。 |
| `github_issue_create` | 写操作，审批门控。 |
| `github_issue_comment` | 写操作，审批门控。 |
| `github_pr_create` | 写操作，审批门控，幂等（同 head/base 已有开放 PR 是正常答案，不是错误）。 |

## 配置

| 字段 | 默认值 | 语义 |
|---|---|---|
| `write` | `true` | 注册三个写工具。关闭后它们完全不出现在工具目录里。 |
| `searchMaxResults` | `8` | 每次搜索的命中上限（search API 限流预算稀缺：30 次/分钟）。 |
| `maxComments` | `30` | 每次读取返回的评论上限。 |
| `diffMaxFiles` / `diffMaxPatchChars` | `50` / `60000` | **工具层持有**的 diff 预算（ADR-0005）：此处持有、传给 seam、由 seam 执行。 |
| `timeoutMs` | `30000` | 挂到每个工具上的协作式超时（由 `dsh-timeout-policy` 执行）。 |

## 审批流（写操作）

每个写操作在 `tools/pre-execute` 返回 `ask`，附带人类可读的理由——目标 repo、标题、正文摘要——正是宿主 ApprovalPanel 渲染的内容。注册表经可选审批 seam 解析该 ask：`allowed-once` 放行；拒绝、取消、审批通道缺失各自物化为不同的模型可见拒绝结果（绝不抛异常），模型可以解释并继续。读工具原样通过闸门。

## 呈现

`presentCall` / `presentResult` 是纯函数、回放安全：读呈现为 `read`/`search` 卡片，写呈现为 `edit` 卡片；`github_pr_create` 把 `created: false` 呈现为 "PR #N already open"。结果 meta 防御性收窄——畸形的回放 meta 回退到通用卡片而不是抛错。

## 模型可行动的错误

seam 失败在工具边界翻译：限流变为携带 `retryAfterMs` 的等待重试提示（并引导改用直接读取而非搜索），鉴权失败点名修复方式（连接 GitHub / 设置 `GITHUB_TOKEN`），not-found 指向 handle 本身。diff 截断附带"缩小范围"提示。

## Model Experience

模型看到六个 schema 严格而小巧的工具；在搜索命中与读取之间流转的可移植 `owner/repo` + `number` handle；为 token 开销调校的精简文本渲染；诚实的截断标记与恢复提示；以及被措辞为"答案"的写拒绝。系统提示词区块预先教会模型 part 拆分的 PR 读取与审批语义。
