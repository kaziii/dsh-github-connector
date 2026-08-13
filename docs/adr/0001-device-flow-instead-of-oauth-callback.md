# 0001. 使用 GitHub Device Flow 而非 OAuth 回调

- 状态：Accepted
- 日期：2026-08-13

## 上下文

"一键连接"需要一个无需用户手工粘贴 token 的授权通路。标准 OAuth Web 回调要求在 GitHub OAuth App 上预注册固定的 redirect_uri，但 dsh 的本地 webserver 端口可配置甚至 `port: 0`（由 OS 分配），回调地址无法预先确定。dsh 是本地分发的开源工具，也不适合在客户端内嵌 client secret。

## 决策

采用 GitHub Device Flow：宿主 `POST /login/device/code` 取得 user_code，前端打开授权页，宿主按 `interval` 轮询换取 access token，写入 `ctx.credentials`。只依赖 client_id，无 secret、无回调。

## 备选方案

- **OAuth Web 回调**：redirect_uri 必须预注册固定值，与可变端口冲突；且需要 secret。
- **仅环境变量 / 手工 PAT**：保留为 CLI/headless 降级路径，但作为唯一通路达不到"一键连接"的产品目标。

## 后果

- 授权页需要用户手工输入 user_code（前端自动复制缓解）。
- GitHub 用户 token（`ghu_`）默认 8 小时过期，而凭据 seam 尚无"过期→刷新"钩子；v1 使用不过期授权模式绕过，refresh 机制列为二期（见 [design §5](../design/design.md)）。
- 轮询需处理 `authorization_pending` / `slow_down` / `expired_token` / `access_denied` 全状态机。
