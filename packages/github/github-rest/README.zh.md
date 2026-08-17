# dsh-github-rest

[English](README.md) | 中文

[`dsh-github`](../github/README.zh.md) 的 **REST v3 provider**：直接使用平台 `fetch`（ADR-0006，不引 octokit），以 provider id **`rest`** 注册进 `ctx.github`。它把 v1 端点全集映射到 seam 的规范化词汇表，并恪守 seam 契约要求的全部策略：每次操作重新解析凭据、诚实截断、不做内建重试。

| 包 | 角色 |
|---|---|
| `dsh-github` | Service Definition：`ctx.github`、词汇表、选择策略、`GitHubError` |
| `dsh-github-rest`（本包） | Provider：REST v3 传输、鉴权、分页、限流/错误映射、幂等 PR 创建、GHES `baseURL` |
| `dsh-tool-github` | Consumer：面向模型的 `github_*` 工具（M3/M4） |

## 配置

| 字段 | 默认值 | 语义 |
|---|---|---|
| `credentialRef` | `GITHUB_TOKEN` | token 所经由的环境变量**名**——只是引用、绝不是秘密本身，settings 文档因此不含任何 token 值。 |
| `baseURL` | `https://api.github.com` | API 根地址。GitHub Enterprise Server 指向 `https://ghes.example.com/api/v3`；容忍尾部斜杠。 |

该配置同时充当 `github-rest` settings 区块（`installSettingsSection`）：settings seam 挂载期间，用户修改**实时生效**——两个字段都在每次操作时重新读取；seam 卸载后自动回退到组合入口配置。

## 凭据解析

每次操作都重新解析（轮换后的 token 无需重启即达下一次调用）：可选的凭据 seam（`ctx.get('credentials')`）挂载且已配置时优先；无论何种情况，进程环境变量都是回退路径——CLI 直接 `export GITHUB_TOKEN` 即可用，无需挂载任何 seam。`available()` 只做本地廉价检查（seam 已挂载，或环境变量非空白），绝不触网；凭据未配置在每次操作中以 `GITHUB_AUTH` 呈现。

## 传输策略

- **分页**：跟随 `Link` header，硬上限 10 页；评论、diff 文件、check runs 跨页聚合。diff 读取在 `maxFiles` 预算可满足时提前停止取页，并诚实上报 `truncated`（ADR-0005——seam 仍会执行预算）。
- **限流**：携带 `retry-after` 或主配额耗尽证据的 403/429 映射为 `GITHUB_RATE_LIMITED { retryAfterMs }`。provider **绝不自动重试**——该决策归调用方（seam 契约）。
- **错误映射**：401 → `GITHUB_AUTH`、404 与 410 → `GITHUB_NOT_FOUND`（410 是 Actions 日志过期时的返回——那是"不存在"，不是传输故障）、422 → `GITHUB_VALIDATION`（原样保留 API 消息）、中止 → `GITHUB_ABORTED`、传输失败 → `GITHUB_PROVIDER_NETWORK`、其余 → `GITHUB_PROVIDER_HTTP`。
- **CI 失败证据**（ADR-0015）：annotation 优先；只有当失败的 check run 没报 annotation（或调用方显式要求）时才去取 job 日志。日志端点会 302 到对象存储，我们**手动跟随且不带 `Authorization` 头**——签名 URL 自带授权，把用户 token 转发给存储域等于泄露凭据。`details_url` 指不出 Actions job 的 run 就没有日志。
- **审查写**（M10）：`POST /pulls/{n}/reviews` 提交审查（行级评论的 side 映射为线上的 `LEFT`/`RIGHT`）、`PATCH /pulls/{n}` 改字段、`POST /pulls/{n}/requested_reviewers` 指派、label 用 `POST`（追加）或 `PUT`（替换）。GitHub 对"批准自己 PR"那句干巴巴的 422 会被改写成说清缘由的人话。
- **幂等 PR 创建**（ADR-0004）：先按精确 head/base 查开放 PR（命中即返回 `created: false`）；未命中才 POST；竞态落败（422 "already exists"）时再查一次并返回胜者的 PR。

## 测试

`tests/github-rest.spec.ts` 通过注入的 `fetch` 回放录制的 fixture 响应——整套测试无 token 可跑。`tests/github-rest.e2e.ts` 是真实 API 只读冒烟，无 `GITHUB_TOKEN` 自动 skip（`pnpm test:e2e`）。

## Model Experience

间接地，经由 `dsh-tool-github`：模型看到的是 seam 的规范化形状与错误码，永远不是这层传输。本包向模型保证的是策略忠实度——诚实的 `truncated` 标志、原样的校验消息、限流附带的 `retryAfterMs`，让工具层能渲染有用的"稍后重试"。
