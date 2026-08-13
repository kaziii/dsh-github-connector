# 0006. 直接使用 fetch 调 REST，不引入 octokit

- 状态：Accepted
- 日期：2026-08-13

## 上下文

`dsh-github-rest` 需要访问 GitHub REST v3。octokit 是官方 SDK，覆盖全 API，但带来一整棵依赖树、自己的重试/限流策略和类型体系；本连接器 v1 只用到十余个端点，且错误必须映射到 seam 的 `GitHubError` 词汇表、限流策略需交给调用方决策。

## 决策

用平台 `fetch` 直接调 REST v3。自行实现：Link header 分页跟随（带页数上限）、限流响应到 `GITHUB_RATE_LIMITED { retryAfterMs }` 的映射、HTTP 状态码到 `GitHubError` code 的映射表、`baseURL` 拼接（GHES 支持）。

## 备选方案

- **octokit**：依赖重；其内建重试/节流与"provider 不自动重试、错误上抛给调用方"的 seam 契约冲突，用它反而要处处关闭内建行为。
- **GraphQL API**：单请求聚合能力强，但 v1 端点少、REST 足够；GraphQL 已明确列为后续项（design §10）。

## 后果

- 零第三方运行时依赖；错误与限流语义完全受 seam 契约控制。
- 分页、限流解析、GHES URL 边界都要自己测（执行计划 M2 的 DoD 已覆盖）。
- 若后续端点数量显著增长或引入 GraphQL，需重新评估（新 ADR）。
