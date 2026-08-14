# dsh GitHub 连接器 — 设计文档

> 状态：已实现（v1，M1–M7）。本文档是与 dsh 仓库调研结论一起沉淀的完整方案，随实现演进；客户端外壳的对接方式见 [ADR-0007](../adr/0007-ui-binds-client-shell-via-port.md)，依赖 dsh 宿主环境的两项手工验收仍挂起（见[执行计划](../plans/execution-plan.md) M3/M6）。
> 实施拆解见[执行计划](../plans/execution-plan.md)；关键取舍的决策记录见 [ADR](../adr/README.md)。

## 1. 目标与产品体验

让 dsh 用户以最低心智负担把 GitHub 接入 agent 工作流：

1. **一键连接**：设置页点击 "Connect GitHub" → 浏览器打开 GitHub Device Flow 授权页 → 授权完成后 dsh 显示"已连接 @用户名"。全程不接触 token 明文、不编辑配置文件。
2. **对话内 PR 工作流**：agent 完成阶段性工作（有新提交）后，输入框上方自动出现状态条：
   - **阶段 1**（分支领先 base，无 PR）：`feat/xxx 领先 master 3 个提交` + [创建 PR ▾]
   - **阶段 2**（PR 已开）：`#123 · CI 通过` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）
   - **阶段 3**（已合并）：`#123 已合并到 master`，短暂确认后收起
3. **模型侧工具**：搜索、读 issue/PR（diff 带 token 预算）、建 issue/评论/PR，写操作走 dsh 现有审批流。

**门控**：状态条仅在「当前项目 git remote 指向 GitHub 且凭据可解析」时出现；未连接用户对该功能无感知。

## 2. 关键机制：确定性的"阶段性成功"检测

不靠 AI 判断任务是否完成。宿主监听 agent 回合结束事件，跑廉价 git 检查：

- 当前分支是否领先 base（`git rev-list --count base..HEAD`）
- 本回合是否产生了新提交
- 该 head 分支是否已有开着的 PR、PR 状态与 CI conclusion

归纳为状态机推给前端（`github/flow-state` 事件）：

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
| `dsh-tool-github` | packages/github/tool-github（agent preset） | **Consumer**：`ctx.tools.register(defineTool(...))` 注册模型工具，`write` 开关 |
| `dsh-github-connect` | host | Device Flow 授权 + git flow-state 检测 + `@Remote` 方法（`createPr` / `mergePr` / `connectStatus`）供前端按钮直调 |
| `dsh-ui-github` | client（React） | 设置页 "Connect GitHub" 区块（注册 `settings.section` slot）+ 输入框上方 PR 状态条（注册 `conversation.input.dock` slot） |

组合分层：Service Definition + Provider 进 host 组合（bundle patch），tool 进 agent preset —— 与 dsh web 家族"服务在宿主、工具在 preset"一致。

## 4. Service Definition 接口草案（已评审）

核心类型（完整草案见评审记录，风格对齐 `dsh-web`）：

- 寻址：`GitHubRepoRef { owner, repo }`、`GitHubItemRef { repo, number, url }`（number+repo 是模型在工具间传递的可移植 handle）
- 读形状：`GitHubIssue`、`GitHubPullRequest`（`merged` 是一等状态；diff 与 checks 拆成独立按需操作）、`GitHubComment`、`GitHubDiff { files, truncated }`、`GitHubChecksResult`
- 搜索：`GitHubSearchKind = 'issues' | 'pull-requests' | 'repositories' | 'code'`（闭合联合，消费端 `switch + assertNever`）
- 写：`GitHubIssueCreateRequest`、`GitHubCommentCreateRequest`、`GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult { pullRequest, created }`（**幂等**：同 head/base 已有开放 PR 时返回既有 PR，`created: false`）
- Provider：单 provider 拥有全部操作（读写拆开会让身份/鉴权产生分歧）；`available()` 只做本地廉价检查
- 错误：`GitHubError extends HarnessError`，开放 string code：`GITHUB_AUTH`、`GITHUB_RATE_LIMITED`（带 `retryAfterMs`）、`GITHUB_NOT_FOUND`、`GITHUB_VALIDATION`、`GITHUB_PROVIDER_*`、`GITHUB_ABORTED`
- diff 预算：`GitHubDiffRequest { maxFiles, maxPatchChars }` 由 consumer 层持有、seam 统一执行截断，`truncated` 永远诚实

## 5. 认证：GitHub Device Flow

选 Device Flow 而非标准 OAuth 回调，因为：

- dsh webserver 端口可配置甚至 `port: 0`（OS 分配），而 OAuth App 的 redirect_uri 必须预注册固定值
- Device Flow 只需 client_id（无 secret），适合本地分发的开源工具

流程：`POST /login/device/code` → 前端 `window.open` 授权页（user_code 自动复制）→ 宿主按 `interval` 轮询 `POST /login/oauth/access_token` → 拿到 token 后 `ctx.credentials.set('GITHUB_TOKEN', ...)` → `credentials/updated` 事件推给前端刷新状态。

已知空白（二期）：凭据 seam 无"过期→刷新"钩子；GitHub 用户 token（`ghu_`）默认 8 小时过期。v1 用不过期授权模式绕过，refresh 机制后补。

CLI/headless 路径保持可用：直接配 `GITHUB_TOKEN` 环境变量或 `.credentials.yaml`，provider 每次操作重新 resolve（换 token 无需重启）。

## 6. 按钮通路（"智能感"的来源）

| 按钮 | 通路 | 是否消耗模型回合 |
|---|---|---|
| 创建 PR | `ctx.remote.github.createPr`（标题/描述由宿主用会话上下文预填，可编辑确认） | 否 |
| Merge | `ctx.remote.github.mergePr`，接现有审批面板做不可逆确认 | 否 |
| AI 审查 | `sessions.prompt("审查 PR #N …")`，正常 agent 回合 | 是（这正是目的） |

## 7. dsh 基建依赖清单（调研结论）

全部现成、无需改 core：

- `ctx.webServer.register`：exact 路由（如需回调；Device Flow 下可不用）
- `ctx.credentials.set/resolve` + `credentials/updated` 事件转发白名单
- `ctx.tools.register(defineTool)` + `presentCall/presentResult`（纯函数，session 回放要求）
- `tools/pre-execute` 审批流 + `ApprovalPanel`（写操作确认）
- client slot 系统：`settings.section`、`conversation.input.dock`、`tool.call.toolview`
- Typert Remote（`@Remote` 方法，前端直调宿主）；全栈模板：`packages/feedback/message-feedback`
- `sessions.prompt`（按钮触发模型回合）

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
6. `dsh-ui-github`：设置区块 + PR 状态条
7. 收尾：catalog 登记、文档 gate、examples 叶子

## 10. 未纳入 v1

PR review（approve / request changes）、merge queue、分支/文件内容读取（与 fs/web seam 职责重叠，需单独讨论）、reactions、GraphQL、token 自动刷新。
