# 0005. diff 预算由 consumer 持有、seam 统一执行

- 状态：Accepted
- 日期：2026-08-13

## 上下文

`github_pr_read` 返回的 diff 直接进入模型上下文，必须有 `maxFiles` / `maxPatchChars` 预算。预算的"数值"和"执行位置"各有多个候选层：工具层（consumer）、seam 层、provider 层。若各 provider 自行截断，`truncated` 标志的语义会随实现漂移。

## 决策

预算数值由 consumer（工具层）持有并随 `GitHubDiffRequest` 传入；截断在 seam 层单点执行，provider 返回全量或已截断均可，seam 保证最终结果不超预算且 `truncated` 永远诚实（发生过任何截断即为 true）。

## 备选方案

- **provider 各自截断**：N 个 provider N 种截断口径，`truncated` 不可信。
- **seam 持有默认预算**：预算本质上是"模型上下文的成本决策"，属于 consumer 的知识；seam 写死数值会让不同工具/场景无法差异化。

## 后果

- 截断逻辑只写一次、只测一处；边界用例（恰好等于预算、单文件超 patch 预算等）在 seam 单测锁定。
- 工具层需为 v1 选定默认值（执行计划 M3：`maxFiles: 50` / `maxPatchChars: 60000`），后续调整不影响 seam。
