# 0010. flow-state 与 PR 操作以会话工作区（session header cwd）为锚点，不再用进程 cwd

- 状态：Accepted
- 日期：2026-08-14

## 上下文

线上验收（`npx @deepseek-ai/dsh web` + npm 安装五包）发现：PR 状态条永远 `hidden`。根因是 `dsh-github-connect` 的所有 git 检查都在 `config.cwd ?? process.cwd()` 上执行——即整个 dsh 服务进程一个全局工作目录。而 dsh 宿主是多工作区、多会话架构：

- 每个会话的不可变 `SessionHeader` 携带自己的 `cwd`（`@deepseek-ai/dsh-session`）；
- `@deepseek-ai/dsh-workspace` 的工作区注册表按 session header 的 canonical cwd 绑定会话归属；
- `agent/turn-stopping` 事件 payload 携带 `agent`，`agent.session.header.cwd` 即该会话的工作目录；
- web 客户端 `conversation.input.dock` slot 的渲染 props 携带 `sessionId`（本包 shell 已用它路由 `prompt`）。

除非用户恰好从目标仓库目录启动 dsh 服务，否则检测锚点必然错误。ADR-0002 定义了确定性检测本身，但未定义"在哪个目录检测"；本决策补上这一层。

另查明 dsh 网关的 Typert Context 路由（`invocation: { kind: 'context' }`）语义：会话身份仅用于**选择 receiver**（解析到 agent 作用域 Context 再 `ctx.get(service)`），被调方法本身拿不到该身份——对 `githubConnect` 这种单例 Service 无法据此还原会话，不能解决本问题。

## 决策

flow-state 检测与全部 PR 操作按**发起会话的工作区**执行 git 检查：

1. **@Remote 路径**：会话身份作为显式 wire 参数随每次调用传递——`refreshFlowState(request?)` / `prDraft(request?)` 增加可选 `request.sessionId`，`createPr` / `mergePr` 的 request 增加可选 `sessionId` 字段，`prChecks(number, sessionId?)` 增加第二参数。宿主经 `ctx.get('sessions')`（可选服务，结构化访问）以 `sessions.get(sessionId).header.cwd` 解析工作目录。
2. **turn-end 路径**：`onTurnEnd` 改读事件 payload 的 `agent.session.header.cwd`。
3. **回退链**：sessionId 缺失、sessions 服务不存在、或 header 无 cwd 时，回退 `config.cwd ?? process.cwd()`——保持单工作区组合（quickstart、无 dsh 宿主的测试）行为不变；`config.cwd` 降级为覆盖项与测试旋钮。
4. **客户端**：shell 端口新增 `sessionId(): string | undefined`（dock slot props 提供）；UI 组件每次调用带上它。手写 contribution 描述符同步增加相应参数（`acceptsUndefined: true`）。
5. 检测缓存（`lastHead`、`lastEmitted` 的去重）按解析后的 cwd 分键，不再是服务级单值。

## 备选方案

- **Typert `kind: 'context'` 按 agent 路由**：网关只用身份选 receiver，单例 Service 方法内无法还原会话身份，机制不匹配（见上下文）。
- **要求用户配置 `config.cwd` 或从仓库目录启动**：单工作区可用，但与 dsh 的多工作区模型根本冲突，且把正确性交给启动姿势。
- **经 `ctx.workspaceRegistry` 反查**：session header 已直接携带 cwd，工作区注册表徒增一个硬依赖，无额外收益。
- **宿主按连接/会话自动注入身份**：dsh 网关的 `InvokeRemoteRequest` 仅含 namespace/method/args，无隐式会话通道；伪造该通道需要改 dsh 本体，超出本仓库边界。

## 后果

- 多工作区/多会话下状态条与按钮首次语义正确；同一 dsh 进程内不同会话互不串扰。
- wire 契约扩宽（全部为可选新增，旧客户端不带 sessionId 仍走回退链，不破坏兼容）；`dsh-ui-github` 与 `dsh-github-connect` 需同步发版。
- 会话无 `header.cwd`（无工作区会话）时行为等同旧版：检测进程目录——多数情况下读 `hidden`，可接受。
- shell 端口面扩一员（ADR-0007 的端口语义不变：仍是窄注入面）；`settings.section` 卡片无需会话身份，不受影响。
- 测试面：flow-state 与按钮用例需覆盖"带 sessionId 解析 header.cwd"与三级回退；per-file 100% 覆盖率门槛不变。
