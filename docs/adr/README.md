# 架构决策记录（ADR）

记录项目中**有替代方案、被有意识做出**的技术决策：当时的上下文、选了什么、放弃了什么、代价是什么。

## 规则

- **不可变**：ADR 记录决策时点的判断，合并后不再修改实质内容（错别字除外）。推翻决策时新增一条 ADR，并把旧条状态改为 `Superseded by NNNN`——这是唯一允许的回改。
- **编号**：四位递增（`0001`、`0002`…），文件名 `NNNN-短横线小写标题.md`。
- **状态**：`Proposed`（讨论中）→ `Accepted`（已采纳）→ `Superseded by NNNN` / `Deprecated`。
- **粒度**：一条 ADR 一个决策。实现细节不进 ADR，进 [design](../design/design.md)。
- **流程**：改变既有决策的 PR 必须先包含对应 ADR；新决策可与实现同 PR。

## 模板

见 [template.md](template.md)。

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-device-flow-instead-of-oauth-callback.md) | 使用 GitHub Device Flow 而非 OAuth 回调 | Accepted |
| [0002](0002-deterministic-flow-state-detection.md) | 用确定性 git 检查而非 AI 判断驱动 PR 状态条 | Accepted |
| [0003](0003-single-provider-owns-read-and-write.md) | 读写操作由单一 provider 拥有 | Accepted |
| [0004](0004-idempotent-pr-creation.md) | PR 创建幂等化 | Accepted |
| [0005](0005-diff-budgets-enforced-at-seam.md) | diff 预算由 consumer 持有、seam 统一执行 | Accepted |
| [0006](0006-fetch-instead-of-octokit.md) | 直接使用 fetch 调 REST，不引入 octokit | Accepted |
| [0007](0007-ui-binds-client-shell-via-port.md) | `dsh-ui-github` 通过注入端口对接客户端外壳 | Accepted |
| [0008](0008-settings-card-entry-and-real-slot-binding.md) | 连接入口落在插件配置卡片，端口按 dsh 真实 slot API 绑定 | Accepted |
| [0009](0009-polling-instead-of-forwarded-events.md) | UI 状态更新用轮询与 credentials 事件，不依赖自定义宿主事件转发 | Accepted |
| [0010](0010-session-cwd-anchors-flow-state.md) | flow-state 与 PR 操作以会话工作区为锚点，不再用进程 cwd | Accepted |
| [0011](0011-create-pr-via-agent-prompt.md) | 状态条 [创建 PR] 直接派发 agent 会话创建，不再弹预填面板 | Accepted |
