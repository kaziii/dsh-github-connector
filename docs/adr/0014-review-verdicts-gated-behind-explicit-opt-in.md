# 0014. review 裁决（approve / request changes）默认关闭，仅评论默认可用

- 状态：Accepted
- 日期：2026-08-17

## 上下文

ADR-0012 把 review 提交纳入范围。`POST /repos/{o}/{r}/pulls/{n}/reviews` 的 `event` 有三个取值，性质差异很大：

- `COMMENT`：留下意见，无状态含义。
- `APPROVE`：**以用户身份**给出批准。在开启了分支保护的仓库里，这一票可能直接解除合并阻塞。
- `REQUEST_CHANGES`：以用户身份阻塞 PR，会给协作者发通知。

三者都会在 PR 时间线上永久留痕（review 可以 dismiss，但记录不会消失），且对协作者可见 —— 这是本项目第一个**有社会后果**的写操作。此前的写操作（建 issue、评论、建 PR）虽然也对外可见，但都不改变任何人的权限状态或阻塞状态。

现有的 `tools/pre-execute` 审批流对这三者一视同仁：都是一个"是/否"确认。而用户在批准一次 `github_issue_comment` 时形成的心理预期，与批准一次"以我的名义 approve 一个 PR"完全不同。

另有一个来自 GitHub 的硬约束：**用户不能 approve 自己创建的 PR**（返回 422）。而状态条 [AI 审查] 按钮的典型场景恰恰是审查自己刚创建的 PR —— 该路径实际上永远只能产出 `COMMENT`。

## 决策

分两层门控：

1. **能力层**：`dsh-tool-github` 新增 preset 配置项 `reviewVerdicts`，**默认 `false`**。为 `false` 时，review 提交工具只接受 `COMMENT`，`APPROVE` / `REQUEST_CHANGES` 在 schema 层就不存在（不是运行期拒绝，而是模型根本看不到这两个取值）。写工具总开关 `write: false` 时，review 提交工具与其他写工具一并不注册。
2. **确认层**：`reviewVerdicts: true` 且 event 为 `APPROVE` / `REQUEST_CHANGES` 时，审批面板必须走强制勾选确认（`RiskConfirmation`，与 Merge 同级），且摘要明示 event、目标 PR、inline 评论条数、正文摘要。`COMMENT` 走普通审批面板。

状态条 [AI 审查] 的 prompt 不引导模型提交裁决 —— 该路径的产出停在会话里，是否回写由用户下一句话决定。

## 备选方案

- **三个 event 一视同仁走普通审批**：实现最省，但把"留个言"和"以我的名义批准"压成同一个确认动作，审批疲劳下用户会习惯性点是。
- **完全不做裁决，只做 `COMMENT`**：最安全，也覆盖了状态条自审场景的全部实际需要。放弃的原因是 ADR-0012 明确要闭环 code review 场景（审查他人 PR），而"能读能评不能判"会让该场景在最后一步断掉；用默认关闭的开关保留能力，比直接砍掉更可逆。
- **默认开启 + 仅靠审批面板兜底**：审批面板是逐次防线，配置开关是一次性防线，前者防不住"批错一次"的后果。默认值应当指向最小权限。
- **按仓库权限自动判定**（能 approve 就放开）：GitHub 权限模型与用户意图无关 —— 有权限不等于希望 agent 代为行使。

## 后果

- `reviewVerdicts` 是继 `write` 之后的第二个工具门控开关，`gen-tool-catalog.ts` 的 config 变体从 default / read-only 扩展为三种以上组合，catalog 快照体积增加。
- 开关为 `false` 时工具 schema 与为 `true` 时不同（event 联合的成员数不同），两种形态都要有 snapshot 锁定，防止默认值被无声改动。
- 自审场景（状态条路径）永远拿不到 approve —— 这是 GitHub 的约束不是本项目的限制，但 422 必须映射为对模型友好的说明（"不能批准自己创建的 PR"），而不是裸的 `GITHUB_VALIDATION`。
- 未来若 dsh 出现分级审批原语，本决策的确认层可以收敛过去；能力层开关应保留。
