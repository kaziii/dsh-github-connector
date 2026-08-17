# 0012. 把 PR 审查闭环纳入范围，取代 v1 的"不做 review"约定

- 状态：Accepted
- 日期：2026-08-17

## 上下文

design §10 把「PR review（approve / request changes）」列为未纳入 v1 的项。当时的判断依据是：v1 的目标是打通"连接 → 创建 → 合并"主干，review 属于加分项。

v1 落地后与同类产品（Claude Code 的 `pr-review-toolkit` 官方插件、`git-pr-workflows`）逐项对照，暴露出这个排除的真实代价不在"不能 approve"，而在**审查这条路径根本没有闭环**：

1. 状态条的 [AI 审查] 只是一句 prompt（"阅读 diff 与检查结果，总结风险"），无维度分工、无严重度口径、无输出契约，产出质量不可预期也不可复现。
2. `github_pr_read` 的 comments 走 `/issues/{n}/comments`，**读不到别人留在代码行上的 review 意见**（那是 `/pulls/{n}/comments`）。"看评审意见然后改"这个最高频的日常动作，模型拿不到输入。
3. checks 只有 conclusion，模型知道 CI 红了但不知道为什么红，"修 CI"同样断在输入端。
4. 审查产出只能停在会话里，无法回到 PR —— 协作者看不到，下次审查也无从续接。

②③是纯读侧缺口，与 approve 的社会后果无关，却被同一条 §10 一并挡住了。继续维持排除，等于让审查这条路径永远停留在"发一句话给模型"。

## 决策

审查闭环整体纳入范围，作为 v2 的主题，按读 → 编排 → 写三段推进：

- **读**：新增 PR review 与 review comment 的读取、CI 失败细节的读取（ADR-0015）。
- **编排**：新增 `github_pr_review` 工具，把审查从"一句 prompt"变为有维度、有 checklist、有输出契约的结构化任务（ADR-0013）。
- **写**：新增 review 提交（inline 评论 + `COMMENT` / `APPROVE` / `REQUEST_CHANGES`），裁决类事件受额外门控（ADR-0014）。

design §10 相应改写：移出「PR review」，其余排除项（merge queue、文件内容读取、reactions、GraphQL、token 自动刷新）维持不变。

## 备选方案

- **只补读侧（②③），继续排除写侧**：成本最低且不动 §10，但审查产出仍然无法回到 PR，闭环只做了一半；且读侧一旦有了 review comment 的形状，写侧复用同一批类型的边际成本很小，分两次做反而要动两次 seam。
- **只升级 [AI 审查] 的 prompt**：不需要任何新接口，能吃掉部分质量收益，但对 ②③ 的输入缺口无能为力 —— prompt 再长也变不出模型读不到的数据。
- **等 GraphQL 一起做**：review 线程的 `resolved` 状态、suggested changes 只有 GraphQL 有。但 REST 已能覆盖本决策的全部三段，为一个附加字段引入第二套协议不划算（ADR-0006 的判断在此仍成立）。

## 后果

- design §10 首次被推翻，v1 的"未纳入"清单不再是冻结集合；后续每次移出都需同等论证。
- seam 接口面显著变宽（review / review comment / annotation / mergeability 等新形状），`dsh-github` 与 `dsh-github-rest` 都要开新端点，per-file 100% 覆盖率的维护成本随之上升。
- 引入第一个**以用户身份发出、对协作者可见**的写操作（review 裁决），安全边界必须单独论证（ADR-0014）。
- 执行计划从 M7 收尾状态重新展开为 M8–M10；v1 的"已实现"状态行需改写为"v1 已实现，v2 进行中"。
