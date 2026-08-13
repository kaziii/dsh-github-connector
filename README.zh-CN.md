# dsh-github-connector

[English](README.md) | **简体中文**

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 GitHub 连接器插件 —— 一键连接 GitHub 账号，不离开 dsh 对话即可创建 PR、AI 审查 PR、合并 PR。

> **状态：设计阶段。** 下述包尚未发布，完整架构见 [docs/design.md](docs/design.md)。安装步骤描述的是预期流程，将随首个版本发布定稿。欢迎贡献与反馈。

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

- 已安装可用的 [dsh](https://github.com/deepseek-ai/deepseek-harness)
- 一个 GitHub 账号（github.com 或 GitHub Enterprise Server）
- CLI / headless 路径需要：带 `repo` 权限的 GitHub personal access token

### 1. 添加插件包

连接器按 dsh 的 capability-seam 模式拆成五个包。宿主平面的包加入 dsh host 组合，工具包加入 agent preset：

| 包 | 安装位置 | 角色 |
|---|---|---|
| `dsh-github` | host 组合 | Service Definition —— `ctx.github`、provider 注册、类型化错误 |
| `dsh-github-rest` | host 组合 | Provider —— fetch 直调 GitHub REST，`baseURL` 支持 GHES |
| `dsh-github-connect` | host 组合 | Device Flow 授权 + git flow-state 检测 |
| `dsh-ui-github` | client | 设置页区块 + 输入框 PR 状态条 |
| `dsh-tool-github` | agent preset | 模型侧工具 |

如果只需要模型侧工具（不要 UI），装 `dsh-github` + `dsh-github-rest` + `dsh-tool-github` 即可。

### 2. 连接 GitHub 账号

**方式 A —— 一键连接（dsh Web 界面，推荐）：**

1. 打开 **dsh 设置 → Connect GitHub**，点击按钮。
2. 浏览器打开 GitHub 设备授权页，user code 已自动复制到剪贴板 —— 粘贴并确认授权。
3. dsh 显示"已连接 @你的用户名"。完成 —— token 存在 dsh 凭据库中，不落任何配置文件。

**方式 B —— 直接配 token（CLI / headless / CI）：**

设置 `GITHUB_TOKEN` 环境变量，或写入 `.credentials.yaml`。provider 每次操作时重新解析凭据，换 token 无需重启。

使用 GitHub Enterprise Server 时，额外通过 provider 的 `baseURL` 配置指向你的实例。

### 3. 验证

对 agent 说一句类似 *"搜索一下我仓库里开着的 issue"* —— 凭据可解析后只读工具即可用。当前项目的 git remote 指向 GitHub 且分支领先 base 时，PR 状态条会自动出现。

## 路线图

1. Seam + REST provider + 只读工具（配 `GITHUB_TOKEN` 后 CLI 即可用）
2. 写工具 + 审批联动
3. Device Flow 连接 + 设置页 UI
4. 输入框 PR 状态条（创建 / AI 审查 / 合并）
5. Token 刷新、PR review（approve / request changes）、GraphQL —— 后续

## 许可证

[MIT](LICENSE)
