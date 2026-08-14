# 0009. UI 状态更新用轮询与 credentials 事件，不依赖自定义宿主事件转发

- 状态：Accepted
- 日期：2026-08-14

## 上下文

ADR-0008 决策 4 留下的验证项已完成源码级验证（`D:\deepseek-harness`）。RPC 方向全部通过：宿主 gateway 无命名空间白名单（SRC 扫描全部 service），`ctx.remote.$mount` 可由任意 client 插件在 `apply` 时调用（effect 归调用方 fiber），patch 层 insert 的 loader entry 会被 client-modules 扫描并服务为 `/plugins/<pkg>/client.js`，手写 strict TYPERT_REMOTE contribution 可行（codec 只要求 `.parse` 函数）。

但事件方向发现硬阻断：宿主→浏览器的事件转发集合是编译期静态数组 `API_REMOTE_FORWARDED_EVENTS`（`packages/api/remotes/src/remote-events.ts:17`，唯一运行时消费者 `packages/host/apiproxy/src/api-proxy.ts:3620`），没有运行时注册 API。`TypertRemoteEventSelection` 是纯类型面——外部包 `declare module` 增强后 `$on('github/flow-state', …)` 通过编译，运行时却静默收不到任何 frame（最坏失败形态）。本仓库 `ui-github/src/types.ts` 声明的 `'github/flow-state'` 与 `'github/device-flow'` 正属此列；`'credentials/updated'` 在名单内。

可用绕行：前端持节奏的 `@Remote` 轮询（CI 徽章已是此模式，页面不可见暂停）；宿主 `rpc.handle` 自建通道；`webServer.register` 自建 SSE 推送。

## 决策

v1 的 UI 不依赖自定义宿主事件转发：

1. 连接/断开状态变化搭 `'credentials/updated'`（名单内事件，token 本就落 credentials 域）。
2. flow-state 迁移与 Device Flow 等待态由前端持节奏的 `@Remote` 轮询驱动（`refreshFlowState`、等待授权期间轮询 `connectStatus`），复用 CI 徽章轮询的页面可见性暂停机制。
3. `types.ts` 的 `TypertRemoteEventSelection` 增强收窄为仅 `'credentials/updated'`；不自建 SSE，不向 dsh 主仓提事件白名单 PR。

## 备选方案

- **自建 SSE 推送**（`webServer.register` + `EventSource`）：真推送，但引入自有连接生命周期与重连管理；v1 的四态迁移 + CI 徽章语义本就是轮询友好，不值得这份复杂度。
- **向 dsh 主仓提 PR 扩转发名单**：归并周期不可控，且违背"不改主仓即可安装"的接入目标；若 dsh 未来提供运行时事件注册 API，可出新 ADR 迁移。
- **保留 `$on` 自定义事件订阅原样等待 dsh 演进**：类型通过、运行时静默失效，是必须消除的坑。

## 后果

- `ui-github` 的 model/状态条对 `'github/flow-state'`、`'github/device-flow'` 的订阅改为轮询驱动，组件测试的脚本化假 Remote 相应调整；宿主侧 `dsh-github-connect` 的这两个事件保留为宿主内部事件（CLI 呈现仍可用），不再假设可达浏览器。
- 轮询节奏成为 UI 的显式配置面（沿用现有 `PollPolicy`），断网/限流的退避语义与 CI 徽章共用。
- ADR-0008 决策 4 的验证项就此关闭（源码级；端到端运行验证随适配层落地一并执行）。
- 合并后同步修订 design §5/§7 的事件措辞与 execution-plan M6 相关描述。
