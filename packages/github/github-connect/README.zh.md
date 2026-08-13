# dsh-github-connect

[English](README.md) | 中文

**GitHub 连接服务**（`ctx.githubConnect`）：从"用户点击 Connect GitHub"到"输入框上方的状态条知道该给什么"之间的一切。三项职责：

1. **Device Flow 授权**（ADR-0001）：`startDeviceFlow()` 立即返回 user code，后台按服务端节奏轮询（`authorization_pending` 继续、`slow_down` 加 5 秒、`expired_token` / `access_denied` 终止）。成功后 token 落入**凭据 seam**（`credentials.set`）——正是其 `credentials/updated` 事件让所有消费方即时刷新，无需重启，且 token 值从不经过前端。v1 使用不过期授权；refresh token 的空白在其将来落点处以代码注释记录。
2. **确定性 flow-state 检测**（ADR-0002）：每次 `agent/turn-stopping` 后，廉价 git 事实（当前分支、head sha、领先数）加一次分支 PR 查询，归纳为四态状态机——`hidden` / `pr-ready` / `pr-open`（带 CI 汇总）/ `pr-merged`——经 `github/flow-state` 事件推送。硬门控：非 GitHub remote 或凭据不可解析 ⇒ 零事件（未连接用户对功能无感知）。没有新提交的回合不发事件（防噪声）。检测绝不向回合抛错。
3. **`@Remote` 按钮方法**（design §6，零模型回合）：`connectStatus()`（带缓存的登录名查询）、`startDeviceFlow()`、`disconnect()`、`createPr()`（分支/base 取自 git，经 seam 幂等创建）、`mergePr()`（squash / merge / rebase；405/409 映射为 `GITHUB_MERGE_BLOCKED`）、供徽章轮询的 `prChecks()` 与 `refreshFlowState()`——轮询节奏由**前端**掌控，页面不可见即停。

## 配置

| 字段 | 默认值 | 语义 |
|---|---|---|
| `clientId` | — | OAuth App client id；缺省则 Device Flow 不可用。 |
| `credentialRef` | `GITHUB_TOKEN` | token 的存取位置（凭据 seam，env 回退）。 |
| `apiBaseURL` / `authBaseURL` | github.com 端点 | GHES：`apiBaseURL` 指向 `/api/v3`，`authBaseURL` 指向 GHES 主机。 |
| `host` | `github.com` | 工作区 remote 必须指向的主机，flow-state 的激活门槛。 |
| `cwd` / `baseBranch` | 进程 cwd / remote HEAD | 工作区与 base 覆盖。 |
| `scope` | `repo` | Device Flow 请求的 OAuth scope。 |

## 事件

- `github/flow-state` —— 状态条的状态（上述四态）。
- `github/device-flow` —— `awaiting-authorization`（含 prompt）→ `slow-down`* → `authorized` | `expired` | `denied` | `failed`。

## 测试

Device Flow 各路径针对完全 mock 的 GitHub OAuth 端点运行；flow-state 迁移在每测试新建的**真实 fixture git 仓库**上运行；service 套件验证凭据写入、`credentials/updated` 广播、门控与无新提交防噪声规则。per-file 100% 覆盖率，无 token 可跑。

## Model Experience

无直接接触——本服务的存在正是为了让按钮**不**消耗模型回合。唯一间接影响：[AI 审查]（M6）经 `sessions.prompt` 触发正常 agent 回合，而它存入的 token 让 `github_*` 工具可用。
