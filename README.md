# dsh-github-connector

GitHub connector for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — connect your GitHub account with one click, then create, review, and merge pull requests right from the dsh conversation.

一键连接 GitHub 账号，在 dsh 对话中直接创建 PR、AI 审查 PR、合并 PR。

> **Status: design phase.** See [docs/design.md](docs/design.md) (中文) for the full architecture and [docs/execution-plan.md](docs/execution-plan.md) (中文) for the milestone-by-milestone execution plan. Contributions and feedback welcome.

## What it does

- **One-click connect** — a "Connect GitHub" button in dsh settings launches the GitHub Device Flow. No token copy-pasting, no config file editing. Tokens are stored through dsh's credential seam and hot-reload on change.
- **PR bar above the composer** — after the agent finishes a turn, the connector checks git state deterministically (branch ahead of base? open PR? CI status?). When there is something actionable, a slim status bar appears above the input box:
  - branch ahead of base → **Create PR** (title/body pre-filled from session context)
  - PR open → live CI badge + **AI review** / **Merge** (squash / merge / rebase)
  - merged → brief confirmation, then the bar retires itself
- **Model-side tools** — `github_search`, `github_issue_read`, `github_pr_read` (diff with token budgets, comments, checks), `github_issue_create`, `github_issue_comment`, `github_pr_create`. Write operations go through dsh's existing approval flow.

Zero AI guessing for the "milestone detection": the trigger is git state, so it costs no tokens and never fires on work that was never committed.

## Architecture

Five packages following dsh's capability-seam pattern (Service Definition / Provider / Consumer):

| Package | Plane | Role |
|---|---|---|
| `dsh-github` | host | Service Definition — `ctx.github`, normalized GitHub vocabulary, provider registry, typed errors |
| `dsh-github-rest` | host | Provider — GitHub REST via `fetch`, credential-ref auth, GHES support |
| `dsh-tool-github` | agent preset | Consumer — model-facing tools registered via `ctx.tools` |
| `dsh-github-connect` | host | Device Flow auth, git flow-state detection, `@Remote` methods for UI buttons |
| `dsh-ui-github` | client | Settings "Connect GitHub" section + composer dock PR bar |

Notable design decisions:

- **Device Flow over OAuth callback** — dsh's local port is configurable, so a pre-registered redirect URI cannot be relied on. Device Flow needs only a client id.
- **Idempotent PR creation** — retrying `github_pr_create` returns the existing open PR (`created: false`) instead of opening a duplicate.
- **Diff budgets enforced at the seam** — `maxFiles` / `maxPatchChars` are owned by the consumer and enforced in one place, with `truncated` always truthful.
- **Buttons never fake intelligence** — Create PR / Merge call deterministic host methods (no model turn); AI review submits a prompt and runs as a normal agent turn.
- **Graceful degradation** — CLI/headless/ACP surfaces fall back to plain tool cards and binary approvals; env-var token config keeps working without the UI.

## Roadmap

1. Seam + REST provider + read tools (CLI-usable with `GITHUB_TOKEN`)
2. Write tools + approval integration
3. Device Flow connect + settings UI
4. Composer PR bar (create / AI review / merge)
5. Token refresh, PR review (approve / request changes), GraphQL — later

## License

[MIT](LICENSE)
