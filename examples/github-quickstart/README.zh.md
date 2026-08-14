# github-quickstart

[English](README.md) | 中文

dsh GitHub 连接器的最小可运行示例——真实跑通 **CLI + token 路径**,并以接线形式给出**完整 UI 路径**。

## 运行

```bash
pnpm install && pnpm build     # 在仓库根执行一次
cd examples/github-quickstart
export GITHUB_TOKEN=ghp_xxx    # 可选;个人访问令牌
pnpm demo                      # 或:node main.ts(Node ≥ 22.18 直接运行 TS)
```

`main.ts` 组合的是真实链路——`ctx.github` seam、REST provider(每次操作解析凭据、进程环境兜底)与 `github_*` 工具套件——然后:

1. 列出已注册工具(与 `tool-catalog.json` 钉住的名字一致),
2. 直接调用 seam(仓库搜索 + 读取 `octocat/Hello-World#7`),
3. 经 `ctx.tools.execute` 执行 `github_search`,打印模型侧的呈现输出,
4. 在你运行它的仓库上做确定性 **flow-state 检测**(design §2)——在分支上提交后再跑,可以看到 `hidden` 变为 `pr-ready`。

全程只读。未设 `GITHUB_TOKEN` 时 API 段跳过并给出指引,flow-state 段照常运行;token 被拒时演示的是类型化拒绝(`GITHUB_AUTH`)而非堆栈。

## UI 路径

`ui-wiring.ts` 是 dsh web 客户端单文件适配层的编译校验形态(ADR-0007):展示 `installGitHubUi` 如何接入客户端的 slot 注册表、`sessions.prompt`、剪贴板/窗口、审批面板与页面可见性。此处不执行——这些设施只存在于 dsh web 客户端内;组合完整体验时把 `wireGitHubUi` 拷入该适配层。
