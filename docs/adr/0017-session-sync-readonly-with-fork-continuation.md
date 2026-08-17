# 0017. session 同步：只读下行完整交付，写入止于 fork 续聊

- 状态：Accepted
- 日期：2026-08-17

## 上下文

[ADR-0016](0016-config-sync-via-github-repo.md) 解决了配置跨机器，剩下的问题是 session：能不能在另一台机器上接着上一次的对话。

在 dsh 源码（`D:\deepseek-harness`）里跑临时探针实测（探针跑完即删，未留在 dsh 仓库），模拟 A 机在 `/machine-a/project` 写下的日志同步到 checkout 在 `/machine-b/project` 的 B 机：

**读路径全部畅通，且不检查 cwd：**

```
[list]    [{"id":"shared-session","cwd":"/machine-a/project"}]
[inspect] OK — meta.cwd = "/machine-a/project", events = 6
[load]    OK — meta.cwd = "/machine-a/project", events = 6
[prepare] OK — resumed header.cwd = "/machine-a/project"
```

**写路径被拒：**

```
REJECTED — session "shared-session" is already persisted at a different cwd
(persisted: /machine-a/project, live: /machine-b/project) (id collision)
```

由此构成一个两难：保留 stored cwd 则 resume 成功但 `header.cwd` 是源机路径，而 `tool-fs` 的 `sessionCwd` 与 `tool-bash` 的 workdir 都读它，agent 会在一个不存在的目录里干活；改用本机 cwd 则连加载都进不去。

**这与并发控制无关**：探针里只有一台机器在写，A 机的 backend 已完全 dispose，照样被拒。因此租约、分布式锁一类方案解的是错误的问题。

fork 路线另测，全链路通过：

```
[create+flush]  OK
[header]        cwd="/machine-b/project"  parent="origin-session"  seedLength=6
[forked types]  [...6 个继承事件..., "6:session/end-seed"]
[continue]      OK — events now 8, last seq 7
[origin log]    cwd="/machine-a/project" events=6 (untouched)
```

本机 cwd 生效、血缘保留、seq 从种子之后连续、父日志一字未动。dsh 还自动插入了 `session/end-seed` 作为显式的种子边界事件。

## 决策

1. **只读下行完整交付**：另一台机器的 session 可被发现（`list`）与浏览（`inspect`，非破坏性且不提交崩溃修复）。这条没有任何技术障碍。
2. **写入止于 fork 续聊**：在本机接着聊，产生一个新 session —— 用 `sessions.create(新 id, { seed, meta: { cwd: 本机, parentSession: 源 id, seedLength } })`，**不使用内置的 `sessions.fork()`**。
3. **明确排除原地接管**（在另一台机器上以同一 session id 继续写入）。不可行的原因写进错误提示，让用户理解这不是 bug。
4. **上行默认关闭**，以 workspace 为粒度显式 opt-in。
5. **GitHub 特有的部分关在内部端口后面**（`SessionSyncPort`），上层不得直接依赖 git 语义或 GitHub API。

## 备选方案

- **原地接管 + 租约/分布式锁**：解错了问题。实证表明单机独写也被拒，阻塞来自 `header.cwd` 而非并发。
- **内置 `sessions.fork()`**：`packages/core/session/src/index.ts:1090` 明写子 session 继承 `liveSource.header.cwd`，fork 出来仍是源机路径，跨机器场景直接废掉。必须手工 `create`。
- **事件级同步**（同步事件而非文件，本地以本机 cwd 重建 header）：这条**确实能解锁双向续聊且不需要改 dsh core**，`readFrom(id, fromSeq)` 就是为这类消费方准备的。但它要求一个能提供写者互斥的后端服务，而且与文件级同步不能混用（否则 B 机会出现两份同 id 日志，`loadStored` 跨 scope 查找即撞车）。定义一个能同时容纳文件级与事件级的通用同步 seam，属于 dsh 主仓的职责，不是一个 GitHub 连接器该做的事。
- **默认全量上行**：session 含完整对话、文件内容与命令输出，默认上传不可接受。

## 后果

- **体验落差**：用户期待"同一个对话继续"，得到的是"新对话，历史继承"。`session/end-seed` 是显式边界事件，UI 可据此画一条"以上为继承自另一台机器的历史"的分隔线，把落差降到最低；但 session id 确实变了，任何以 session id 为锚的引用需要跟着血缘走。
- **隐私**：上行即上传给 GitHub。除 opt-in 外有一个意外收获——GitHub 的 push protection 会拒绝含 secret 的推送，等于白拿一道泄露防线。
- **workspace 身份**：`workspace.json` 与 session 目录 slug 都以绝对路径标识工作区，跨平台不可移植。本连接器天然知道 repo remote，用 `owner/repo` 对齐两台机器上路径不同的同一项目，是这里唯一可行且独有的解法。
- **为上游留形状**：决策第 5 条的端口沿用 [ADR-0007](0007-ui-binds-client-shell-via-port.md) 的做法（先手写端口，等 dsh 出真构件再收敛）。待形态跑通后可带着实证向 dsh 上游提通用同步 seam，届时本实现降级为 provider，上层不必重写。
- **未验证项**（落地时应补）：其一，同 id 不同 cwd 在事件级重建下于本机不冲突——F1 探针只验证了换 id 的情形；其二，"内置 `fork()` 继承源 cwd"是源码事实而非实测，因为探针在更早的一步就被 `cannot publish session "X": persisted state already owns this identity` 拦下了（已持久化的 session 只能经 `prepare()` 复活）。
