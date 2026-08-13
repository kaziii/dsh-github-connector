# 0004. PR 创建幂等化

- 状态：Accepted
- 日期：2026-08-13

## 上下文

`github_pr_create` 会被模型调用，也会被 UI 按钮触发。模型重试、会话回放、用户重复点击都可能对同一 head/base 重复发起创建；GitHub 对重复创建返回 422，直接透传会让模型误判为失败并继续无效重试。

## 决策

创建 PR 的语义定为幂等：同 head/base 已存在开放 PR 时，返回既有 PR 且 `created: false`，不报错。实现上先查询开放 PR，未命中才 POST；POST 收到 422 "already exists"（竞态窗口）时兜底再查询一次返回既有 PR。结果类型 `GitHubPullRequestCreateResult { pullRequest, created }` 把两种路径显式区分。

## 备选方案

- **透传 422 错误**：模型需要自行理解 GitHub 错误文案并改用查询，增加无效回合。
- **只在工具层去重**：UI 按钮通路（`@Remote` 直调）绕过工具层，幂等性必须在 seam/provider 语义里保证才能覆盖所有调用方。

## 后果

- 所有调用方（模型工具、UI 按钮、重试逻辑)获得一致语义；`created: false` 在工具呈现层显示为"已有开放 PR #N"。
- 创建路径多一次查询请求；竞态兜底路径需要专门 fixture 锁定（执行计划 M2 已列入）。
