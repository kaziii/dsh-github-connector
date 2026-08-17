# 0016. dsh 配置通过 GitHub 私有仓库同步，走 git 协议而非 contents API

- 状态：Accepted
- 日期：2026-08-17

## 上下文

dsh 是本地工具，没有账号体系：换一台机器要重新配置 profile 与设置。本连接器已经通过 Device Flow 拿到了 GitHub 身份（[ADR-0001](0001-device-flow-instead-of-oauth-callback.md)），默认请求的 `repo` scope 已覆盖创建私有仓库与推送，**同步能力不需要新增任何权限**。

实测本机 `~/.dsh` 的构成，各部分差异极大：

| 数据 | 实测 | 性质 |
|---|---|---|
| `settings.yaml` | 54 字节 | 用户配置，可移植 |
| `profiles/*/` 的 `cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml` | headless 整目录 8 KB | profile 的**源**，可移植 |
| `profiles/*/node_modules` | web profile 1.7 MB | 可由 `pnpm install` 重建，平台相关 |
| `.credentials.yaml` | 独立文件 | 凭据 |
| `storages/session_projcache.json` | — | 缓存，可重建 |
| `storages/workspace.json` | — | 含绝对路径 `D:\app-gate` |

关键事实是 **profile 的"源"只有四个小文件**，其余是可重建产物；以及**凭据位于独立文件**，与配置天然分离。

载体上有两种传输方式，性质完全不同：contents API 要把整个文件 base64 后上传（超 1 MB 还要转 blob API），且消耗 REST core 配额；git 协议天然增量、天然去重、非快进即冲突检测，且不计入 REST 配额。[design §10](../design/design.md) 排除的是 **contents API**，git 协议是另一件事。

## 决策

1. **同步范围用白名单**：`settings.yaml`，以及各 profile 的 `cordis.yml` / `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml`。白名单之外的一切默认不同步。
2. **明确排除**：`.credentials.yaml`（永不同步，无论任何配置）、`node_modules`、`storages/` 下的缓存。`storages/workspace.json` 因含绝对路径本条不纳入，留给 [ADR-0017](0017-session-sync-readonly-with-fork-continuation.md) 的 workspace 身份讨论。
3. **载体**：用户 GitHub 账号下的私有仓库（默认名 `dsh-sync`），**用 git 协议传输，不用 contents API**。
4. **token 不进 remote URL**：用 `git -c http.extraHeader=` 传递，避免写入 `.git/config` 明文——与本项目"token 只走 credentials 域"的既有姿态一致。
5. **同步能力始终 opt-in**，dsh 核心不得依赖它。

## 备选方案

- **contents API**：踩 design §10 的排除项，消耗 REST 配额，且对文本配置要整文件重传。git 协议在三个维度上都更优，没有理由选它。
- **Gist**：更轻，但没有目录结构（profile 是多文件多目录），且 gist 的"secret"是不可猜测 URL 而非真正的私有权限。配置文件不该靠 URL 隐蔽性保护。
- **同步整个 `~/.dsh`**：会带上 1.7 MB 平台相关的 `node_modules`，以及——最严重的——`.credentials.yaml`。
- **黑名单**：dsh 未来新增的任何敏感文件都会默认被同步上去。白名单在这里是唯一安全的默认。

## 后果

- **连接 GitHub 从"可选功能"逼近"账号体系入口"**，这与 design §1 的门控原则（未连接用户对该功能无感知）存在张力。因此决策第 5 条把同步钉死为 opt-in：让 dsh 核心依赖某个连接器插件，是 dsh 主仓的决策，不是本项目能单方面做的。
- 同步的是 profile 的源而非产物，因此在新机器上落地后需要一次 `pnpm install` 重建 `node_modules`。这是有意的取舍：8 KB 对 1.7 MB，且产物平台相关。
- **需要一次实测**：连续 100 次小增量 push，确认 git 传输确实不计入 REST core rate limit（观察 `X-RateLimit-Remaining` 是否变化）。这条目前是合理推断而非已验证事实，应作为落地的验收项。
- 因为传输是纯 git 协议，内网部署者可用 GHES（`baseURL` 已支持）或任何自建 git 服务（GitLab / Gitea），只有仓库创建这一步依赖 GitHub API。
