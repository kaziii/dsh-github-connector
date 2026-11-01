# 0018. 适配 dsh 0.2.1-rc.5：以宿主 0.2.x 接口为准，移除 invariant 伴生插件

- 状态：Accepted
- 日期：2026-11-01

## 上下文

本仓库开发时的宿主是 dsh `0.0.1-rc.1` / `0.1.0-rc.6`。宿主升级到 `0.2.1-rc.5` 后出现一组成对的破坏性变化，用户侧表现为「插件装不上」（上游 issue #16 / #17：兼容性闸门拒绝安装），即使强行放行也会在启动时 import 失败：

- **兼容性闸门**：`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 在插件声明 `engines.dsh` 时只看该字段，否则逐条校验 `@deepseek-ai/dsh*` peer 范围（含 prerelease）。旧的 peer 范围（`^0.0.1-rc.1` / `^0.1.0-rc.6`）无法匹配 `0.2.1-rc.5`。
- **invariant 机制移除**：宿主不再包含 `@deepseek-ai/dsh-invariants` 包，也没有 `ctx.invariants` 服务与 `./invariant` 伴生插件的加载路径。
- **工具与提示 API**：`@deepseek-ai/dsh-tools` 的 `ToolRegistry` 更名为 `ToolRuntime`；`@deepseek-ai/dsh-llm` 不再导出 `CallId` / `assertNever`（补齐断言用 `assertNever` 本地实现，调用标识用 `ToolCallId`）。
- **凭据事件拆分**：`dsh-credentials` 的 `credentials/updated` 拆成 `credentials/reference-updated(ref)` 与 `credentials/record-updated(key)`。
- **设置区**：`dsh-settings` 不再提供 `installSettingsSection` / `settingsNamespace`；设置表单改为由插件 `Config` 的 `.volatile()` 字段按 profile entry id 投影。
- **客户端插件**：`@deepseek-ai/dsh-client-runtime` 已不存在；客户端模块由 `dsh-client-modules` 等包承担，`dsh.client.inject` 声明服务提供者包、`dsh.client.external` 声明非基线的精确模块请求，node 半侧没有 react。

## 决策

1. 目标宿主固定为 dsh `0.2.1-rc.5`：五个插件包声明 `engines.dsh: ">=0.2.1-rc.5 <0.3.0"`，peer/dev 依赖整体对齐 `0.2.1-rc.5`（`@deepseek-ai/cordis` 对齐 `~4.0.5`）。
2. 删除全部 `./invariant` 子导出、`src/invariant.ts` 伴生插件、`@deepseek-ai/dsh-invariants` 依赖及其测试；该门槛从工程约定中移除。
3. 设置区迁移到 `Config` 的 `.volatile()` 字段 + profile entry 定位，不再手工注册 settings namespace；provider 改为直接读配置引用（每次操作重新解析）。
4. 凭据监听迁移到 `credentials/reference-updated`，只在更新的引用等于配置的 `credentialRef` 时失效登录状态缓存。
5. 工具注册沿用 `defineTool` + `ctx.tools.register`，宿主注册中心改为 `ToolRuntime`；工具目录登记脚本同步更新。
6. UI 客户端按 0.2.x 契约改写 `dsh.client` 清单（inject 服务提供者包 / external 非基线请求），node 半侧不 import react，UI 组件只存在于浏览器 bundle。

## 备选方案

- **维持 0.1.x 并等上游**：宿主已升级，插件在现网完全不可用（issues #16 / #17 已证实），没有可用路径。
- **双兼容**（运行时探测宿主版本、维护两套接线）：测试矩阵翻倍、类型面无法同时精确，收益只覆盖已不再分发的旧宿主；放弃。
- **本地 vendor 旧宿主包 / 用 `allow-version` 豁免闸门**：把风险转嫁给用户运行时，且宿主删除的服务无法靠豁免复原（实测三个包 import 即失败）；放弃。

## 后果

- 旧宿主（≤ `0.1.x`）不再支持；peer 依赖、锁文件、示例与文档整体前移。
- invariant 伴生插件原本承担的「注册即可被检查」约束消失；本仓库这些 companion 均为空实现，因此没有行为损失，但后续若需要跨包不变量约束，只能落在业务入口与测试里。
- 设置表单的可编辑性依赖宿主 Loader 对 `volatile` 配置引用的行为，需要在真实宿主上验收（隔离 profile 启动 + 设置卡片可见）。
- `engines.dsh` 上限 `<0.3.0` 明确限制范围；宿主下一次破坏性升级需要重新核对本 ADR。
