# dsh-ui-github

[English](README.md) | 中文

dsh web 客户端的 **GitHub 工作流 UI**（design §1）：两个 React slot 填充件，完全由 `dsh-github-connect` 的 `@Remote` 方法加前端持节奏的轮询驱动（ADR-0009——dsh 不向浏览器转发自定义宿主事件；本 UI 唯一使用的转发事件是 `credentials/updated`）。

1. **"Connect GitHub" 卡片**（作为 `settings.plugin.item` 卡片落在 dsh 插件 → 插件配置 页，ADR-0008）：[连接 GitHub] 启动 Device Flow——用户码自动复制、授权页自动打开，进度按服务端节奏轮询 `deviceFlowStatus` 获得（`slow_down` 时拉长间隔）；已连接用户看到 `已连接 @login` 与 [断开连接]。token 永不经过前端。
2. **对话 PR 状态条**（`conversation.input.dock` slot），Claude Code 风格的紧凑胶囊条、贴合会话列宽，即 design §1 的三阶段：`repo feat/x +N −M` + [创建 PR] + [×] → `#123 · CI 徽章` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）+ [×] → `#123 已合并`，短暂展示后收起。未连接用户不可见；断开连接后立即消失；[×] 收起胶囊直到状态变化。[创建 PR] 单击即经 `sessions.prompt` 交给 agent 回合——模型根据会话上下文归纳标题/描述并用 GitHub 工具创建，按钮保持 loading 至轮询状态迁移（超时兜底，ADR-0011）；[Merge] 直调 `@Remote` 并走不可逆确认；[AI 审查] 同样经 `sessions.prompt` 消耗回合。

两个轮询器都指数退避且**页面不可见时停止**：CI 徽章（`prChecks`）与 flow-state（`refreshFlowState`，未变化的轮次绝不关闭已打开的下拉、丢弃草稿或让已收起的合并横幅复现）——风险表中"轮询不能吃掉 rate limit"的规则。

## 绑定方式（ADR-0007/0008）

本包通过 `src/types.ts` 的两份契约对接 web 客户端：**`GitHubUiShell` 端口**（slot 注册、`prompt`、`openExternal`、`copyText`、`confirmIrreversible`、页面可见性），以及手写的 `githubConnect` 命名空间 **Typert Remote 客户端面**，待 Typert 生成器跑过宿主包后原样替换。一次调用完成安装：

```ts
import { installGitHubUi } from 'dsh-ui-github'

const dispose = installGitHubUi(shellAdapter, typertClientRemote, { locale: 'zh-CN' })
```

## dsh client 半侧（`dsh-ui-github/client`）

`src/client/` 是该端口面向真实 dsh web 部署的成品实现（ADR-0008），采用 dsh client 插件形态：`exports["./client"]` + `dsh.client` 清单、空 node `apply`（其 loader entry 由本包 `cordis.patch.yml` 经 `dsh plugin add` 落位，锚定 dsh 的 client-module 扫描）、以及构建为 dsh 模块加载器执行的 CJS 闭包工厂的 `lib/client.js`（`scripts/build-client-bundle.ts`；仅 react 与 cordis 保持 external）。启动时经 `ctx.remote.$mount` 自行挂载手写的 `githubConnect` contribution——无需改动 dsh 主仓——再经浏览器外壳适配器安装两个界面：设置填充件落为 `settings.plugin.item` 卡片，[AI 审查] 经 `ctx.sessions.scope(sessionId).conversation.send` 发送，外链仅以 http(s) 新标签页打开，locale 跟随页面语言。所消费的 dsh 服务类型以 `src/client/shims.ts` 垫片声明，迁入 dsh 工作区时删除。

## i18n

内建两个 locale（`en`、`zh-CN`）的完整目录（`catalogFor`）；两个 slot 的全部用户可见字符串成对维护。

## 测试

组件测试在 jsdom 下用脚本化的假 Remote 与假外壳驱动：四个流状态经轮询的渲染与迁移、断开连接后状态条立即消失、Device Flow 全程（等待 → 授权 → 已连接，以及拒绝 / 过期 / 失败）、退避与暂停节奏、agent 驱动的创建（prompt 派发、loading 保持、超时）、[×] 的忽略记忆、未变化轮次下菜单的存活、合并横幅的收起记忆、diff 统计胶囊，以及 client 半侧（contribution codec、浏览器外壳、插件 apply）。100% per-file 覆盖率，无需任何 token。

## Model Experience

无直接影响——本 UI 存在的意义正是让按钮**不**消耗模型回合。唯一面向模型的效果是 [AI 审查] 按钮：把本地化的审查提示词（`审查 PR #N…`）作为正常 agent 回合送入会话；其余一切直达 `dsh-github-connect`。
