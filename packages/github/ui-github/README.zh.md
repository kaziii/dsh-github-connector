# dsh-ui-github

[English](README.md) | 中文

dsh web 客户端的 **GitHub 工作流 UI**（design §1）：两个 React slot 填充件，完全由 `dsh-github-connect` 的 `@Remote` 方法与转发事件驱动。

1. **设置页 "Connect GitHub" 区块**（`settings.section` slot）：[连接 GitHub] 启动 Device Flow——用户码自动复制、授权页自动打开，进度经转发的 `github/device-flow` 事件到达；已连接用户看到 `已连接 @login` 与 [断开连接]。token 永不经过前端。
2. **对话 PR 状态条**（`conversation.input.dock` slot），即 design §1 的三阶段：`feat/x 领先 main 3 个提交` + [创建 PR ▾]（标题/描述可编辑）→ `#123 · CI 徽章` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）→ `#123 已合并`，短暂展示后收起。未连接用户不可见；断开连接后立即消失。[创建 PR] 与 [Merge] 直调 `@Remote`（零模型回合，Merge 走不可逆确认）；[AI 审查] 是唯一消耗回合的按钮，经 `sessions.prompt`。

CI 徽章由前端指数退避轮询（`prChecks`），且**页面不可见时停止**——风险表中"checks 轮询不能吃掉 rate limit"的规则。

## 绑定方式（ADR-0007）

dsh 客户端平面是 registry-restricted，因此本包通过 `src/types.ts` 的两份契约对接 web 客户端：**`GitHubUiShell` 端口**（slot 注册、`prompt`、`openExternal`、`copyText`、`confirmIrreversible`、页面可见性），由 web 客户端在组合时用一个文件适配；以及手写的 `githubConnect` 命名空间 **Typert Remote 客户端面**，形状对齐 `@deepseek-ai/dsh-message-feedback` 的 `typert.remote-client` 生成构件，待 Typert 生成器跑过宿主包后原样替换。一次调用完成安装：

```ts
import { installGitHubUi } from 'dsh-ui-github'

const dispose = installGitHubUi(shellAdapter, typertClientRemote, { locale: 'zh-CN' })
```

## i18n

内建两个 locale（`en`、`zh-CN`）的完整目录（`catalogFor`）；两个 slot 的全部用户可见字符串成对维护。

## 测试

组件测试在 jsdom 下用脚本化的假 Remote 与假外壳驱动：四个流状态的渲染与事件驱动迁移、断开连接后状态条立即消失、Device Flow 全程（等待 → 授权 → 已连接，以及拒绝 / 过期 / 失败）、轮询的退避与暂停节奏、两个下拉菜单。100% per-file 覆盖率，无需任何 token。

## Model Experience

无直接影响——本 UI 存在的意义正是让按钮**不**消耗模型回合。唯一面向模型的效果是 [AI 审查] 按钮：把本地化的审查提示词（`审查 PR #N…`）作为正常 agent 回合送入会话；其余一切直达 `dsh-github-connect`。
