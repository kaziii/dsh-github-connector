# dsh-github-connector

[English](README.md) | **简体中文**

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 GitHub 连接器插件 —— 一键连接 GitHub 账号，不离开 dsh 对话即可创建 PR、AI 审查 PR、合并 PR。

> **状态：v1 已实现**（七个里程碑全部完成，见 [CHANGELOG](CHANGELOG.md)）。文档：[索引](docs/README.md)、[架构](docs/design/design.md)、[执行计划](docs/plans/execution-plan.md)、[ADR](docs/adr/README.md)。Agent 贡献者从 [AGENTS.md](AGENTS.md) 开始。欢迎贡献与反馈。

## 插件介绍

dsh-github-connector 把 GitHub 工作流带进 dsh agent 会话：

- **一键连接** —— 在 dsh 设置页点击 "Connect GitHub" 按钮，走 GitHub Device Flow 授权。无需复制粘贴 token，无需编辑配置文件；token 存入 dsh 凭据层，更换后热生效。
- **输入框上方的 PR 状态条** —— agent 回合结束后，连接器用确定性的 git 检查判断当前状态（分支是否领先 base？是否已有 PR？CI 状态？）。有可操作事项时，输入框上方出现一条轻量状态条：
  - 分支领先 base → **创建 PR**（标题/描述由会话上下文预填，可编辑确认）
  - PR 已开 → 实时 CI 徽章 + **AI 审查** / **合并**（squash / merge / rebase）
  - 已合并 → 短暂确认后自动收起
- **模型侧工具** —— `github_search`、`github_issue_read`、`github_pr_read`（diff 带 token 预算、评论、checks）、`github_issue_create`、`github_issue_comment`、`github_pr_create`。写操作走 dsh 现有审批流。

"阶段性成功"的检测完全不靠 AI 猜测：触发信号是 git 状态，零 token 成本，也不会在没有提交的工作上误报。

## 安装指引

### 前置条件

- Node ≥ 22.19 与 pnpm;dsh CLI:`npm install -g @deepseek-ai/dsh`
- agent 回合需要 `DEEPSEEK_API_KEY`（dsh web 的 Models 页可代存）
- 一个 GitHub 账号（github.com 或 GitHub Enterprise Server）
- CLI / headless 路径需要：带 `repo` 权限的 GitHub personal access token

### 1. 添加插件包

包尚未发布到 npm——从本仓库安装。每个宿主平面的包都声明了 `dsh.bundle` patch,`dsh plugin add` 会自动把它们激活为 profile 层：

```bash
git clone https://github.com/kaziii/dsh-github-connector.git
cd dsh-github-connector && pnpm install && pnpm build

dsh plugin --profile headless add \
  "$PWD/packages/github/github" \
  "$PWD/packages/github/github-rest" \
  "$PWD/packages/github/tool-github" \
  "$PWD/packages/github/github-connect"

dsh --profile headless --dump-config   # 四行出现在组合后的 profile 中
```

（把 `headless` 换成你的 profile 名——`web`、`tui` 等。）五个包遵循 dsh 的 capability-seam 模式：

| 包 | 安装位置 | 角色 |
|---|---|---|
| `dsh-github` | host 组合 | Service Definition —— `ctx.github`、provider 注册、类型化错误 |
| `dsh-github-rest` | host 组合 | Provider —— fetch 直调 GitHub REST，`baseURL` 支持 GHES |
| `dsh-github-connect` | host 组合 | Device Flow 授权 + git flow-state 检测 |
| `dsh-ui-github` | client | 设置页区块 + 输入框 PR 状态条 |
| `dsh-tool-github` | agent preset | 模型侧工具 |

如果只需要模型侧工具（不要 UI），装 `dsh-github` + `dsh-github-rest` + `dsh-tool-github` 即可。`dsh-ui-github` 是唯一暂不能经 `dsh plugin add` 激活的包：它渲染在 web 客户端内，等待客户端外壳适配层（[ADR-0007](docs/adr/0007-ui-binds-client-shell-via-port.md)）。

### 2. 连接 GitHub 账号

**方式 A —— 一键连接（dsh Web 界面，推荐）：**

1. 打开 **dsh 设置 → Connect GitHub**，点击按钮。
2. 浏览器打开 GitHub 设备授权页，user code 已自动复制到剪贴板 —— 粘贴并确认授权。
3. dsh 显示"已连接 @你的用户名"。完成 —— token 存在 dsh 凭据库中，不落任何配置文件。

**方式 B —— 直接配 token（CLI / headless / CI）：**

设置 `GITHUB_TOKEN` 环境变量，或写入 `.credentials.yaml`。provider 每次操作时重新解析凭据，换 token 无需重启。

使用 GitHub Enterprise Server 时，额外通过 provider 的 `baseURL` 配置指向你的实例。

### 3. 验证

```bash
export DEEPSEEK_API_KEY=sk-…
export GITHUB_TOKEN=ghp_…
dsh --profile headless "搜索 octocat/Hello-World 里开着的 issue"
```

凭据可解析后只读工具即可用。web profile 下，当前项目的 git remote 指向 GitHub 且分支领先 base 时，PR 状态条会自动出现。

## 路线图

1. Seam + REST provider + 只读工具（配 `GITHUB_TOKEN` 后 CLI 即可用）
2. 写工具 + 审批联动
3. Device Flow 连接 + 设置页 UI
4. 输入框 PR 状态条（创建 / AI 审查 / 合并）
5. Token 刷新、PR review（approve / request changes）、GraphQL —— 后续

## 许可证

[MIT](LICENSE)
