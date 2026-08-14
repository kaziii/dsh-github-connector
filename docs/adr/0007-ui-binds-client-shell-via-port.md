# 0007. `dsh-ui-github` 通过注入端口对接客户端外壳

- 状态：Accepted
- 日期：2026-08-14

## 上下文

M6 要求 `dsh-ui-github` 把设置区块和 PR 状态条注册进 dsh web 客户端的 slot 系统（`settings.section` / `conversation.input.dock`），并使用 `sessions.prompt`、剪贴板、外链打开与不可逆确认等客户端设施（design §7）。开工前按风险表复核 slot 契约时发现：dsh 的客户端平面（React 外壳、slot 注册表、Typert Client Remote 运行时）与 `@deepseek-ai/dsh-type-meta` 一样是 registry-restricted，未发布到公共 npm；已发布且可依赖的只有 `@deepseek-ai/dsh-typert-protocol` 的客户端契约类型（`TypertClientRemote`、`TypertRemoteMap` 等），以及全栈模板 `@deepseek-ai/dsh-message-feedback` 的 `./remote` 生成构件所示范的 module-augmentation 模式。本仓库的既定原则是"包可原样迁入 dsh 工作区"（tsconfig.base 注释），实现不能依赖取不到的包。

## 决策

`dsh-ui-github` 不直接 import 客户端外壳，改为面向两份本包声明的契约开发（`src/types.ts`）：

1. **`GitHubUiShell` 端口**：slot 注册、`prompt`、`openExternal`、`copyText`、`confirmIrreversible`、页面可见性——恰好覆盖 design §7 列出的客户端设施，不多一项。dsh web 客户端在组合时用一个薄适配文件把真实 slot 注册表与设施接到该端口上。
2. **Typert Remote 客户端面**：手写 `githubConnect` 命名空间的 `TypertRemoteMap` / `TypertRemoteNamespaceMap` / `TypertRemoteEventSelection` 增强，形状对齐模板包的生成构件；待 dsh Typert 生成器跑过 `dsh-github-connect` 的 FaceModel 后，用生成构件原样替换。

组件测试用脚本化的假端口与假 Remote 驱动全部状态迁移,不需要 dsh 客户端在场。

## 备选方案

- **等待客户端包发布**：M6 无限期阻塞，且与 M1–M5 一样可以用"契约在手、实现后补"的方式推进。
- **深度复刻客户端外壳（stub 整个 slot 系统）**：工作量大、复刻面会漂移；端口只锁"本包需要什么"，不锁"外壳如何实现"。
- **把 UI 并入 `dsh-github-connect` 宿主包**：混淆 host/client 平面，违背 design §3 的包结构分层。

## 后果

- M6 的组件、状态机、轮询与 i18n 全部可在本仓库内以 100% 覆盖率验证；迁入 dsh 工作区时只需替换 `types.ts` 的两处绑定（外壳适配 + 生成构件），组件代码零改动。
- 端口类型是本包对外壳的显式需求清单，dsh slot 契约演进时 diff 一目了然（风险表 M6 项的常态化处理）。
- 真实外壳适配层在 dsh 主仓落地前无法在此仓库联调；端到端手工验收（M6 DoD 第三项）继续挂起，与 M3 的手工验收项同批执行。
