# AGENTS.md

Coding agent 在本仓库工作的入口上下文。人类贡献者同样适用。

## 项目一句话

dsh-github-connector：为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 提供 GitHub 连接能力——一键授权（Device Flow）、对话内 PR 工作流（创建 / AI 审查 / 合并）、模型侧 GitHub 工具。**当前状态：v1 已实现（M1–M7），五个包位于 `packages/github/`，可运行示例在 `examples/github-quickstart/`；仅剩依赖 dsh 宿主环境的两项手工验收挂起（见执行计划 M3/M6）。** 常用命令：`pnpm typecheck` / `pnpm test` / `pnpm test:coverage` / `pnpm build` / `pnpm gate:catalog`。

## 文档地图（改动前必读）

| 文件 | 作用 | 什么时候读 |
|---|---|---|
| [docs/design/design.md](docs/design/design.md) | 总体设计：架构、seam 接口、认证、UI | 动任何代码/接口前 |
| [docs/plans/execution-plan.md](docs/plans/execution-plan.md) | M1–M7 里程碑、任务、验收标准（DoD）、风险 | 开工前确认当前里程碑与范围 |
| [docs/adr/](docs/adr/README.md) | 架构决策记录（为什么这样定） | 想改变既有设计方向前 |
| [docs/README.md](docs/README.md) | 文档分类与管理规范的完整定义 | 新建/移动/改写文档前 |

## 硬规则

1. **文档规范以 [docs/README.md](docs/README.md) 为准**，本文件只做摘要，两者冲突时以 docs/README.md 为准并修复本文件。
2. **决策先行**：推翻既有设计决策（认证方式、包结构、seam 语义等）必须先新增 ADR（流程见 [docs/adr/README.md](docs/adr/README.md)），再改 design / plans / 代码。ADR 合并后不可修改，只能被新 ADR 取代。
3. **按里程碑开工**：实现工作严格跟随 execution-plan 的 M1→M7 顺序与 DoD；完成任务时同步勾选对应 checkbox 并更新文件头部状态行。
4. **范围纪律**：design §10 列出的"未纳入 v1"内容（PR review、merge queue、GraphQL、token 自动刷新等）不做，除非先出 ADR 变更范围。
5. **语言**：`docs/` 内中文；根 `README.md` 中文为主，英文版在 `README.en.md`；提交信息英文。

## 工程门槛（代码落地时生效，源自 design §8）

- 每包：`./invariant` 子导出、per-file 100% 覆盖率、REAL-composition 测试、keyless snapshot（无 token 可跑全量测试）、`*.e2e.ts` 无 token 自动 skip
- 函数插件**禁止 default export**（dsh Loader 会丢 inject）
- 工具包必须登记 `scripts/gen-tool-catalog.ts` boot manifest
- 每包双语 README（含 `## Model Experience` 章节）+ i18n 配对
- 可选服务用 `ctx.get('credentials')`，注册即 effect

## 提交约定

- Conventional Commits（`docs:` / `feat:` / `fix:` / `test:` …），主题行英文。
- 文档结构性改动（移动/新建目录）与内容改动分开提交。
