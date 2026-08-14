# 0008. 连接入口落在插件配置卡片，端口按 dsh 真实 slot API 绑定

- 状态：Accepted
- 日期：2026-08-14

## 上下文

ADR-0007 因 dsh 客户端平面 registry-restricted 而让 `dsh-ui-github` 面向自声明端口（`GitHubUiShell` + 手写 Typert Remote 客户端面）开发，真实绑定挂起。现在 dsh 完整源码已在本地可查（`D:\deepseek-harness`），核实到的事实：

1. Web 客户端由 slot 注册表驱动（`ctx.slots.register` / `ctx.slots.inject`，`SlotMap` declaration merging）。**ADR-0007 假设的两个 slot 名 `settings.section` 与 `conversation.input.dock` 在源码中原样存在**（`packages/client/ui-settings/src/client/contract/slots.ts`、`packages/client/ui-conversation/src/client/contract/slots.ts`），后者的文档注释明确定位为输入框上方独占一行的状态条座位（现有使用者：goal bar、queue、todo）。
2. 设置页栏目全部由插件注册，第三方可选三个层级：顶级栏目（`settings.section`）、"插件"栏目新标签页（`settings.plugins.tab`）、"插件配置"页内卡片（`settings.plugin.item`）。卡片有现成 chrome（展开/保存/覆盖徽章）与带按钮 + 密钥写入的完整模板（web-search 卡片，密钥走 credentials 域 `api.credentials.set`，dsh 明确否决密钥进 settings 分节）。
3. client 插件形态约定：package.json `exports["./client"]` + `dsh.client.{inject, platform:"web"}` 双向一致（有门禁），node 半侧空 `apply`；client 包之间禁止 value import，跨插件走 cordis service。
4. 仓库外插件存在两处编译期白名单：Remote 挂载列表（`packages/api/remotes/src/client/index.ts`）与 settings 暴露白名单（apiproxy `WEB_SETTINGS_NAMESPACES`）。`TypertClientRemote.$mount(contribution)` 是公开方法，client 插件自行挂载本包 Remote 面在类型上可行，未经运行验证。
5. 端口各成员均有真实落点：slot 注册、`ctx.sessions.scope(sessionId).conversation.send`（发 prompt）、`writeClipboard`（ui-primitives）、`RiskConfirmation`（不可逆确认）、页面可见性；外链无命令式服务，惯例是安全锚点渲染（http(s) 白名单 `<a target="_blank" rel="noopener noreferrer">`）。

## 决策

1. **连接入口注册 `settings.plugin.item`**：GitHub 连接以"插件 → 插件配置"页内一张卡片呈现（未连接：Connect 按钮触发 Device Flow；已连接：登录名 + 断开），不注册独立 `settings.section` 栏目。design §7 的"设置区块"语义收窄为该卡片。
2. **`GitHubUiShell` 端口保留为测试缝，真实适配按源码证实的 API 实现**：适配层是 `ui-github` 新增的 `./client` 半侧（dsh client 插件形态，见上下文 3），把端口成员绑定到 `ctx.slots` / `ctx.sessions` / ui-primitives 设施；`openExternal` 语义改为安全锚点渲染由组件承担，端口相应成员在实现期收敛。具体映射表进 design §7，不进本 ADR。
3. **token 只走 credentials 域**，不申请进入 `WEB_SETTINGS_NAMESPACES`。
4. **Remote 面优先由 client 半侧 `ctx.remote.$mount` 自行挂载**（生成 `./remote` 构件后）；若运行验证发现外部挂载被阻断，则回退为向 dsh 主仓提 PR 进白名单，且该结论以补充 ADR 或本 ADR 转 Accepted 时的验证记录固化。

## 备选方案

- **独立 `settings.section` 栏目**：单一连接器占一个顶级导航栏目，信息架构过重；卡片层级与 dsh 现有"可配置插件"心智一致，且免费获得卡片 chrome。
- **`settings.plugins.tab` 新标签页**：该层级语义面向插件集合视图（如 inventory），不适合单个连接器的连接/断开操作。
- **继续等待 dsh 客户端包发布**（ADR-0007 备选的延续）：源码已在手，绑定事实已核实，无需再等。
- **token 进 settings 分节 + 申请白名单**：dsh 侧已明确否决密钥进 settings；credentials 域是既定通道且与本仓库 design 的 `ctx.get('credentials')` 同构。

## 后果

- `ui-github` 组件、状态机、轮询、i18n 代码不动（ADR-0007 端口隔离的兑现）；新增 client 半侧清单、适配 `apply`、宿主侧 `TypertRemoteService` + `@Remote` 面与生成 `./remote` 构件。
- 待验证项：外部插件 `$mount` 是否可运行通过（决策 4 的分支条件），需在适配层落地时最先以最小 demo 验证。
- 本 ADR 合并后需同步修订 design §7（端口映射表、入口措辞）与 execution-plan M6 DoD 措辞（"设置区块"→"插件配置卡片"）；M6 端到端手工验收由"挂起待外壳"改为"待适配层落地后执行"。
- ADR-0007 不被取代：端口继续作为组件测试缝存在，本 ADR 只固化其真实绑定与入口选型。
