# dsh-github

[English](README.md) | 中文

**`GitHubRuntime`**（`ctx.github`）定义 harness 拥有怎样的 GitHub 访问能力——搜索、读 issue/PR/diff/checks、建 issue/评论/PR——通过注册的 provider 执行，而不把模型契约绑死在某一种传输实现的 API 形状上。

本包承担 GitHub 能力的 Service Definition 角色（设计见 [docs/design/design.md](../../../docs/design/design.md) §3–§4）：

| 包 | 角色 |
|---|---|
| `dsh-github`（本包） | Service Definition：服务、provider 注册表、选择策略、读写词汇、seam 层 diff 预算执行、`GitHubError` 错误分类 |
| `dsh-github-rest` | Provider：`fetch` 直调 GitHub REST v3（M2） |
| `dsh-tool-github` | Consumer：基于 `ctx.github` 的模型侧 `github_*` 工具（M3/M4） |

读与写刻意由**单一 provider 接口**拥有（ADR-0003）：它们共享身份、凭据与限流配额，拆开会让鉴权状态产生分歧。

## 服务 API（`ctx.github`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册一个后端。id 重复时抛 `GitHubError` `GITHUB_PROVIDER_DUPLICATE`。返回 disposer，随注册方 fiber 一起销毁。 |
| `search(request, signal?)` | 解析 provider 并执行一次搜索。seam 对结果执行 `request.maxResults`（截断 `items[]` 并置 `truncated`）。 |
| `getIssue` / `getPullRequest` / `getComments` / `getChecks` | 规范化的按需读取。PR 元数据不内嵌 diff 与 checks——它们是独立调用。 |
| `getDiff(item, request?, signal?)` | 读 PR diff，并在 seam 层执行 consumer 持有的 `maxFiles` / `maxPatchChars` 预算（ADR-0005）。`truncated` 永远诚实：无论 provider 侧还是 seam 侧发生过任何削减即为 true。 |
| `getReviews` / `getReviewComments` | 已提交的审查裁决，以及它们携带的行级评论。`GitHubReviewComment` 刻意不等同于 `GitHubComment`：它带文件路径与行号，处理方式是去改那段代码。 |
| `getCheckFailures(item, request?, signal?)` | 失败的检查为什么失败：CI 工具报了 annotation 就用它，否则取受 consumer 持有的 `maxLogLines` / `maxLogChars` 预算约束的日志**尾部**（ADR-0015）。诚实规则同 `getDiff`——单是 provider 侧截断过的日志，就足以让整个结果标记为 truncated。 |
| `createIssue` / `createComment` / `createPullRequest` | 写操作。PR 创建幂等（ADR-0004）：同 head/base 已有开放 PR 时返回既有 PR，`created: false`。 |

provider 注册的是**能力**而非工具。模型可见的名称、描述、提示词、JSON schema 与呈现均由 `dsh-tool-github` 独家拥有。

## 选择策略

选择不依赖注册、配置或 HMR 顺序。要么显式配置 provider id（配置项 `provider`，或喂给同一字段的环境变量 `$DSH_GITHUB_PROVIDER`），要么恰有一个可用 provider 时自动选中。操作在**每次调用时**执行期解析 provider——从不缓存——因此凭据变更翻转 `available()` 后无需重启即生效：

| 情形 | 执行 |
|---|---|
| 配置的 id 已注册且 `available()` | 运行该 provider |
| 配置的 id 未注册 | `GITHUB_PROVIDER_CONFIGURED_MISSING` |
| 配置的 id 已注册但不可用 | `GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置 id，恰有一个可用 provider | 运行它 |
| 未配置 id，无可用 provider | `GITHUB_PROVIDER_UNAVAILABLE` |
| 未配置 id，多个可用 provider | `GITHUB_PROVIDER_AMBIGUOUS` |

provider 的 `available()` 是廉价的本地检查（凭据 ref 可否解析），**禁止发起网络调用**。

## 词汇

`GitHubRepoRef`（`owner`、`repo`）与 `GitHubItemRef`（`repo`、`number`、`url?`）是模型在工具间传递的可移植 handle。读形状：`GitHubIssue`、`GitHubPullRequest`（`merged` 是一等状态）、`GitHubComment`、`GitHubDiff`（`files[]`、`truncated`）、`GitHubChecksResult`。`GitHubSearchKind` 是闭合联合（`issues` | `pull-requests` | `repositories` | `code`）——消费端 `switch` 穷尽。写形状：`GitHubIssueCreateRequest`、`GitHubCommentCreateRequest`、`GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult`（`pullRequest`、`created`）。seam 以 `GITHUB_VALIDATION` 校验 ref（owner/repo 非空、编号为正整数）与预算参数。完整契约与 `GitHubError` 错误码分类（`GITHUB_AUTH`、带 `retryAfterMs` 的 `GITHUB_RATE_LIMITED`、`GITHUB_NOT_FOUND`、`GITHUB_VALIDATION`、`GITHUB_ABORTED`、`GITHUB_PROVIDER_*`）见 `src/types.ts`。

## Model Experience

间接的：经由 `dsh-tool-github` 呈现有界的规范化 GitHub 数据或上述结构化失败码（限流附带 retry-after 提示）；本注册表自身不贡献任何提示词或 schema。
