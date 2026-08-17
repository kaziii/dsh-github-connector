# 0015. CI 失败细节以 check-run annotations 为主、日志尾部为辅

- 状态：Accepted
- 日期：2026-08-17

## 上下文

v1 的 `github_pr_read` checks 部分只返回 check-run 的 `conclusion`。模型能看到"红了"，看不到"为什么红"，所以"CI 挂了 → 修好它"这个闭环断在输入端（ADR-0012 列为纳入范围的理由之三）。

GitHub 提供两种失败细节，性质差别很大：

| 来源 | 端点 | 形状 | 体积 |
|---|---|---|---|
| check-run annotations | `GET /repos/{o}/{r}/check-runs/{id}/annotations` | 结构化：`path` / `start_line` / `annotation_level` / `message` | 每条几十到几百字节，通常个位数条 |
| workflow job 日志 | `GET /repos/{o}/{r}/actions/jobs/{id}/logs`（302 → 纯文本） | 无结构的完整 stdout | 动辄数百 KB 到数 MB |

annotations 是 CI 工具（编译器、linter、测试报告 action）主动上报的结构化结论，本身就是 `path:line + message`，与本项目其他读形状（diff、review comment）的粒度一致。但覆盖不全：只有配置了 annotation 上报的 action 才有，`npm test` 直接失败、脚本 `exit 1`、依赖安装失败这类都不会产生任何 annotation。

日志覆盖全，但把它整个塞进模型上下文是灾难 —— 且失败信息几乎总在末尾（栈回溯、失败摘要、退出码），前面是大段安装与编译噪声。

## 决策

分两级取用，`ci-failures` 读取按这个顺序：

1. 先取失败 check-run 的 annotations。有 annotation 即以其为结果，不拉日志。
2. 无 annotation（或调用方显式要求日志）时，才取对应 workflow job 的日志，且**只保留尾部**若干行，按 ADR-0005 同款预算机制执行：预算数值由 consumer 持有（`maxLogLines` / `maxLogChars`），截断在 seam 单点执行，`truncated` 永远诚实。

只处理**失败的** check-run（`conclusion` 为 `failure` / `timed_out` / `cancelled`），成功的不取细节。

## 备选方案

- **只做 annotations**：token 最省、形状最干净，但漏掉最常见的"脚本直接挂了"，等于没解决问题。
- **只做日志**：覆盖全但浪费 —— 有 annotation 时它已经是被 CI 工具提炼过的结论，再从日志里让模型重新找一遍是纯粹的 token 损耗。
- **取日志头部或全量**：失败信息在尾部，头部是噪声；全量超预算。
- **让模型自己决定取哪个**：多一个来回，且模型无法预知有没有 annotation。这个判断是确定性的（annotation 列表空不空），应由宿主做 —— 与 ADR-0013 的分工一致。

## 后果

- 新增两类端点依赖，其中 job 日志走 302 重定向到对象存储，`restRequest` 的 fetch 需处理跨域重定向且**不得携带 Authorization 头**转发到存储域；日志响应不是 JSON，现有 `restRequest` 的 JSON 解析路径要开一条文本分支。
- 日志尾部截断是按行还是按字符会影响可读性（半行截断），实现取"先按字符预算截，再向前对齐到行首"，边界用例单测锁定。
- Actions 日志端点在 GHES 与 github.com 上路径一致，但归档日志有保留期（默认 90 天），过期返回 410 —— 需映射为 `GITHUB_NOT_FOUND` 并给模型可读说明，而非 `GITHUB_PROVIDER_HTTP`。
- check-run 与 workflow job 是两套 id 体系，二者的关联需要额外一次 `GET /actions/runs/{id}/jobs`；这条链路的成本在 M8 实测后若不可接受，可退化为"只在调用方显式请求日志时才走"。
