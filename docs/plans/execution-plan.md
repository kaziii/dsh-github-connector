# dsh GitHub 连接器 — 执行计划

> 状态：执行中——M1 已完成（`dsh-github` seam 落地，DoD 全绿），当前推进 M2。依据 [design.md](../design/design.md)（设计定稿）拆解为可直接开工的里程碑与任务清单。设计取舍的理由见 [ADR](../adr/README.md)。
> 原则：每个里程碑结束时**产物独立可用、可测、可合并**；严格按依赖顺序推进，不并行开新面。

## 0. 总览

| 里程碑 | 内容 | 交付物 | 用户可见价值 |
|---|---|---|---|
| M1 | `dsh-github` seam | Service Definition 包（类型 + 注册 + 错误） | 无（基建） |
| M2 | `dsh-github-rest` provider | REST provider 包（鉴权/分页/限流/错误映射） | 无（基建） |
| M3 | 只读工具三件套 | `dsh-tool-github`（search / issue_read / pr_read） | **CLI 用户配 `GITHUB_TOKEN` 即可用** |
| M4 | 写工具 + 审批 | issue_create / issue_comment / pr_create | 模型可代用户写 GitHub |
| M5 | `dsh-github-connect` | Device Flow 授权 + flow-state 检测 + `@Remote` 方法 | 一键连接（后端就绪） |
| M6 | `dsh-ui-github` | 设置区块 + 输入框上方 PR 状态条 | **完整产品体验** |
| M7 | 收尾 | catalog 登记、文档 gate、examples | 可发布 |

依赖链：M1 → M2 → M3 → M4；M5 依赖 M1/M2（不依赖 M3/M4）；M6 依赖 M5；M7 依赖全部。
M5 可与 M3/M4 并行（如有人力），但默认串行推进。

---

## M1 — `dsh-github` Service Definition

**位置**：`packages/github/github`（host plane）

### 任务

1. 包骨架：`package.json`、`./invariant` 子导出、tsconfig，对齐 `dsh-web` 家族包结构。
2. 类型定义（照 design §4 定稿）：
   - 寻址：`GitHubRepoRef { owner, repo }`、`GitHubItemRef { repo, number, url }`
   - 读形状：`GitHubIssue`、`GitHubPullRequest`（`merged` 一等状态）、`GitHubComment`、`GitHubDiff { files, truncated }`、`GitHubChecksResult`
   - 搜索：`GitHubSearchKind = 'issues' | 'pull-requests' | 'repositories' | 'code'`（闭合联合）
   - 写请求/结果：`GitHubIssueCreateRequest`、`GitHubCommentCreateRequest`、`GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult { pullRequest, created }`
   - diff 预算：`GitHubDiffRequest { maxFiles, maxPatchChars }`
3. `GitHubError extends HarnessError`：开放 string code（`GITHUB_AUTH` / `GITHUB_RATE_LIMITED`(+`retryAfterMs`) / `GITHUB_NOT_FOUND` / `GITHUB_VALIDATION` / `GITHUB_PROVIDER_*` / `GITHUB_ABORTED`）。
4. `ctx.github` 服务：provider 注册（effect + disposer）、执行期解析（每次操作 resolve，不缓存 provider 实例）、无 provider / `available() === false` 时抛 `GITHUB_PROVIDER_*`。
5. diff 截断逻辑放 seam 层（provider 返回全量或已截断均可，seam 统一执行预算并保证 `truncated` 诚实）。
6. invariant：ref 合法性（owner/repo 非空）、预算参数为正整数等。

### 验收（DoD）

- [x] per-file 100% 覆盖率通过
- [x] REAL-composition 测试：注册 fake provider → `ctx.github` 各操作可走通
- [x] 无 provider、provider 不可用、并发注册两个 provider 的行为都有测试锁定
- [x] 截断逻辑单测：`maxFiles` / `maxPatchChars` 边界、`truncated` 标志正确性
- [x] 函数插件无 default export（门槛 §8）

---

## M2 — `dsh-github-rest` Provider

**位置**：`packages/github/github-rest`（host plane）

### 任务

1. `fetch` 直调 REST v3，不引 octokit；`baseURL` 可配（GHES）。
2. 鉴权：credential-ref（默认 `GITHUB_TOKEN`），**每次操作重新 resolve**（换 token 无需重启）；`available()` 只做本地廉价检查（凭据 ref 可解析与否，不打网络）。
3. 端点映射（v1 全集）：
   - 搜索：`GET /search/issues`（issues + PR）、`/search/repositories`、`/search/code`
   - issue/PR 读：`GET /repos/{o}/{r}/issues/{n}`、`/pulls/{n}`、`/pulls/{n}/files`（diff）、评论列表、`/commits/{ref}/check-runs`（checks）
   - 写：`POST /repos/{o}/{r}/issues`、`/issues/{n}/comments`、`/pulls`
4. 分页：Link header 跟随，内部上限（如 10 页）防失控；评论/文件列表聚合。
5. 限流与重试：`403/429 + retry-after / x-ratelimit-reset` → `GITHUB_RATE_LIMITED { retryAfterMs }`，不在 provider 内自动重试（交给调用方/工具层决策）。
6. 错误映射表：401→`GITHUB_AUTH`、404→`GITHUB_NOT_FOUND`、422→`GITHUB_VALIDATION`、AbortSignal→`GITHUB_ABORTED`、其余→`GITHUB_PROVIDER_HTTP`。
7. **幂等 PR 创建**：`createPullRequest` 先 `GET /pulls?head=owner:branch&base=...&state=open`，命中则返回 `{ pullRequest, created: false }`；未命中才 POST；POST 422 "already exists" 兜底再查一次（竞态窗口）。
8. `installSettingsSection` 挂接用户设置（token / baseURL）。

### 验收（DoD）

- [ ] keyless snapshot 测试：所有端点用录制的 fixture 响应回放，无 token 可跑
- [ ] `*.e2e.ts`：真实 API 冒烟（无 token 自动 skip）
- [ ] 限流、401、404、422、abort 的映射各有测试
- [ ] 幂等创建的三条路径（已存在 / 新建 / 竞态 422 兜底）全覆盖
- [ ] GHES `baseURL` 拼接测试（含尾部斜杠等边界）

---

## M3 — 只读工具三件套（首个可用里程碑）

**位置**：`packages/github/tool-github`（agent preset）

### 任务

1. `github_search`：kind 闭合联合 `switch + assertNever`；结果精简（标题/编号/状态/URL），控制 token 占用。
2. `github_issue_read`：正文 + 评论（分页聚合，评论数上限）。
3. `github_pr_read`：元数据 + 按需子操作（`diff` / `comments` / `checks` 拆开，避免一次拉全）；diff 预算默认值在**工具层**持有（如 `maxFiles: 50` / `maxPatchChars: 60000`），透传给 seam 执行。
4. `presentCall` / `presentResult` 纯函数（session 回放要求），错误呈现友好（限流→"稍后重试"提示 + retryAfter）。
5. preset 注册：`ctx.tools.register(defineTool(...))`；`write` 开关此时只放读工具。

### 验收（DoD）

- [ ] snapshot 测试：每个工具的 present 输出定型
- [ ] diff 截断在超预算 PR fixture 上验证 `truncated: true` 且提示模型"可缩小范围重查"
- [ ] REAL-composition：preset + seam + fake provider 全链路
- [ ] **手工验收**：CLI 配 `GITHUB_TOKEN`，模型可搜索/读 issue/读 PR —— 此里程碑后对外可用

---

## M4 — 写工具 + 审批联动

### 任务

1. `github_issue_create`、`github_issue_comment`、`github_pr_create` 三工具，受 `write` 开关门控（默认开，可在 preset 配置关）。
2. 接 `tools/pre-execute` 审批流：写操作弹 `ApprovalPanel`，展示目标 repo、标题、正文摘要；拒绝→工具返回被拒结果（不抛异常，模型可继续）。
3. `github_pr_create` 幂等语义在工具层呈现：`created: false` 时 present 为"已有开放 PR #N"而非报错。
4. CLI/headless 降级路径验证：二选一审批可用。

### 验收（DoD）

- [ ] 审批通过 / 拒绝 / 超时三条路径测试
- [ ] `write: false` 时写工具不注册（catalog 里也不出现）
- [ ] 幂等重试场景 snapshot（两次 `github_pr_create` 第二次 `created: false`）

---

## M5 — `dsh-github-connect`（Device Flow + flow-state）

**位置**：host plane

### 任务

1. Device Flow：
   - `POST /login/device/code`（只需 client_id）→ 返回 `user_code` / `verification_uri` / `interval`
   - 宿主按 `interval` 轮询 `POST /login/oauth/access_token`，处理 `authorization_pending` / `slow_down`(+5s) / `expired_token` / `access_denied`
   - 成功 → `ctx.credentials.set('GITHUB_TOKEN', ...)` → `credentials/updated` 事件推前端
   - v1 用不过期授权模式（refresh 二期，design §5 已记录空白）
2. `@Remote` 方法（照 `packages/feedback/message-feedback` 全栈模板）：
   - `connectStatus()`：凭据可解析？→ 查 `/user` 拿登录名（带缓存）
   - `startDeviceFlow()` / `pollDeviceFlow()`（或宿主自轮询 + 事件推送，实现时定夺，倾向后者：前端只开窗 + 听事件）
   - `createPr({ title, body, base })`：标题/描述由宿主用会话上下文预填，前端可编辑确认
   - `mergePr({ number, method })`：squash / merge / rebase
3. flow-state 检测：监听 agent 回合结束事件 → 廉价 git 检查（`git rev-list --count base..HEAD`、本回合新提交、head 分支开放 PR 及 CI conclusion）→ 归纳状态机 → `github/flow-state` 事件推前端。状态机四态照 design §2。
4. 门控：remote 非 GitHub 或凭据不可解析 → 不发事件（未连接用户零感知）。
5. CI 徽章刷新：PR 开着时轮询 checks（带退避，页面不可见时暂停——由前端订阅控制）。

### 验收（DoD）

- [ ] Device Flow 状态机全路径测试（pending / slow_down / expired / denied / 成功），GitHub 端点全 mock
- [ ] flow-state 检测在 fixture git 仓库上测：无领先 / 领先无 PR / PR 开 / PR 合并四态迁移
- [ ] 回合结束无新提交时不发事件（防噪声）
- [ ] `credentials/updated` 白名单转发验证

---

## M6 — `dsh-ui-github`（React client）

### 任务

1. 设置页 "Connect GitHub" 区块（注册 `settings.section` slot）：
   - 未连接：[Connect GitHub] 按钮 → `window.open` 授权页 + user_code 自动复制 + 等待态
   - 已连接：`已连接 @用户名` + [断开]
2. PR 状态条（注册 `conversation.input.dock` slot），三阶段 UI 照 design §1：
   - 阶段 1：`feat/xxx 领先 master 3 个提交` + [创建 PR ▾]（下拉：编辑标题/描述后确认）
   - 阶段 2：`#123 · CI 徽章` + [AI 审查] [Merge ▾]（squash / merge commit / rebase / 在 GitHub 打开）
   - 阶段 3：`#123 已合并`，短暂展示后自动收起
3. [AI 审查] → `sessions.prompt("审查 PR #N …")`（唯一消耗模型回合的按钮）；[创建 PR] / [Merge] 直调 `@Remote`（零模型回合）。
4. Merge 接现有审批面板做不可逆确认。
5. i18n 配对（中英）；错误态（限流/断网/token 失效）就地提示。

### 验收（DoD）

- [ ] 组件测试：四态渲染 + 事件驱动迁移
- [ ] 断开连接后状态条立即消失
- [ ] **端到端手工验收脚本**（写进 PR 描述）：连接 → agent 提交 → 状态条出现 → 创建 PR → CI 徽章 → AI 审查 → merge → 收起

---

## M7 — 收尾与发布

1. `scripts/gen-tool-catalog.ts` boot manifest 登记（工具包硬性门槛）。
2. 双语 README（每包，含 `## Model Experience` 定型章节）+ i18n 校对。
3. examples 叶子：最小可运行示例（CLI + token 路径 / 完整 UI 路径）。
4. 文档 gate 全绿；全仓 lint / typecheck / coverage 复查。
5. 发布清单：版本号、changelog、design.md 状态从"未开工"更新为"已实现（v1）"。

---

## 风险与预案

| 风险 | 影响 | 预案 |
|---|---|---|
| 凭据 seam 只存单字符串，Device Flow 未来要存 refresh_token | M5 | v1 用不过期授权；结构化 token 序列化为 JSON 字符串的方案先在 M5 里留注释占位，不实现 |
| `credentials.set` 钉死 loopback，远程 Web UI 不可用 | M5/M6 | 明确文档化为已知约束；不在本项目解决 |
| search API 限流（30 req/min，远低于 core API） | M3 | `github_search` 结果精简 + 限流错误引导模型改用直接读取 |
| `checks` 轮询打爆 rate limit | M5 | 退避轮询 + 前端不可见即停订阅 |
| dsh slot API（`conversation.input.dock`）演进 | M6 | M6 开工前重新核对 dsh 主仓 slot 契约，发现变化先改设计再动工 |
| PR 创建竞态（幂等兜底路径少测） | M2 | 422 兜底路径单独 fixture 锁定 |

## 工程门槛核对清单（每包合并前）

- [ ] `./invariant` 子导出
- [ ] per-file 100% 覆盖率
- [ ] REAL-composition 测试
- [ ] keyless snapshot（无 token 可跑全量测试）
- [ ] `*.e2e.ts` 无 token 自动 skip
- [ ] 函数插件无 default export
- [ ] 双语 README + i18n 配对
- [ ] 可选服务用 `ctx.get('credentials')`，注册即 effect
