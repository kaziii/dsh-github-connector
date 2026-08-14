# dsh-github-connector

[English](README.md) | **简体中文**

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 GitHub 连接器插件 —— 一键连接 GitHub 账号，不离开 dsh 对话即可创建 PR、AI 审查 PR、合并 PR。

- **一键连接** —— 在 dsh 设置页走 GitHub Device Flow 授权，无需复制粘贴 token。
- **输入框上方的 PR 状态条** —— 创建 PR / AI 审查 / 合并，由 git 状态触发。
- **模型侧工具** —— `github_search`、`github_issue_read`、`github_pr_read`、`github_issue_create`、`github_issue_comment`、`github_pr_create`。

文档：[索引](docs/README.md) · [架构](docs/design/design.md) · [ADR](docs/adr/README.md)

## 安装

前置条件：Node ≥ 22.19、pnpm、dsh CLI（`npm install -g @deepseek-ai/dsh`）。

从 npm 一条命令安装：

```bash
dsh plugin --profile web add dsh-github dsh-github-rest dsh-tool-github dsh-github-connect dsh-ui-github
```

（把 `web` 换成你的 profile 名 —— `headless`、`tui` 等。`dsh-ui-github` 只在 web 客户端渲染，非 web profile 可不装。）

然后连接账号：打开 **dsh 设置 → Connect GitHub** 走 Device Flow；CLI / headless 场景则设置 `GITHUB_TOKEN` 环境变量（带 `repo` 权限的 personal access token）。

## 许可证

[MIT](LICENSE)
