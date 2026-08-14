# dsh-github-connector

**English** | [简体中文](README.zh-CN.md)

A GitHub connector plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — connect your GitHub account in one click, then create, review, and merge pull requests without leaving the dsh conversation.

> **Status: v1 implemented** (all seven milestones; see [CHANGELOG](CHANGELOG.md)). Docs (中文): [documentation index](docs/README.md), [architecture](docs/design/design.md), [execution plan](docs/plans/execution-plan.md), [ADRs](docs/adr/README.md). Agent contributors start at [AGENTS.md](AGENTS.md). Contributions and feedback welcome.

## Introduction

dsh-github-connector brings the GitHub workflow into your dsh agent sessions:

- **One-click connect** — a "Connect GitHub" button in dsh settings launches the GitHub Device Flow. No token copy-pasting, no config file editing. Tokens are stored through dsh's credential seam and hot-reload on change.
- **PR bar above the composer** — after the agent finishes a turn, the connector checks git state deterministically (branch ahead of base? open PR? CI status?). When there is something actionable, a slim status bar appears above the input box:
  - branch ahead of base → **Create PR** (title/body pre-filled from session context)
  - PR open → live CI badge + **AI review** / **Merge** (squash / merge / rebase)
  - merged → brief confirmation, then the bar retires itself
- **Model-side tools** — `github_search`, `github_issue_read`, `github_pr_read` (diff with token budgets, comments, checks), `github_issue_create`, `github_issue_comment`, `github_pr_create`. Write operations go through dsh's existing approval flow.

Zero AI guessing for the "milestone detection": the trigger is git state, so it costs no tokens and never fires on work that was never committed.

## Installation

### Prerequisites

- Node ≥ 22.19 and pnpm; the dsh CLI: `npm install -g @deepseek-ai/dsh`
- A `DEEPSEEK_API_KEY` for agent turns (the dsh web Models page can store it)
- A GitHub account (github.com or GitHub Enterprise Server)
- For the CLI/headless path: a GitHub personal access token with `repo` scope

### 1. Add the plugin packages

The packages are not on npm yet — install them from this repository. Each host-plane package declares a `dsh.bundle` patch, so `dsh plugin add` activates it as a profile layer automatically:

```bash
git clone https://github.com/kaziii/dsh-github-connector.git
cd dsh-github-connector && pnpm install && pnpm build

dsh plugin --profile headless add \
  "$PWD/packages/github/github" \
  "$PWD/packages/github/github-rest" \
  "$PWD/packages/github/tool-github" \
  "$PWD/packages/github/github-connect"

dsh --profile headless --dump-config   # the four rows appear as profile layers
```

(Substitute your profile name — `web`, `tui`, … — for `headless`.) The five packages follow dsh's capability-seam pattern:

| Package | Where it goes | Role |
|---|---|---|
| `dsh-github` | host composition | Service Definition — `ctx.github`, provider registry, typed errors |
| `dsh-github-rest` | host composition | Provider — GitHub REST via `fetch`, GHES support via `baseURL` |
| `dsh-github-connect` | host composition | Device Flow auth + git flow-state detection |
| `dsh-ui-github` | client | Settings section + composer PR bar |
| `dsh-tool-github` | agent preset | Model-facing tools |

If you only need the model-side tools (no UI), `dsh-github` + `dsh-github-rest` + `dsh-tool-github` is enough. `dsh-ui-github` is the one package `dsh plugin add` cannot activate yet: it renders inside the web client and waits on the client-shell adapter ([ADR-0007](docs/adr/0007-ui-binds-client-shell-via-port.md)).

### 2. Connect your GitHub account

**Option A — one-click (dsh web UI, recommended):**

1. Open **dsh Settings → Connect GitHub** and click the button.
2. Your browser opens the GitHub device-authorization page; the user code is copied to your clipboard automatically — paste it and approve.
3. dsh shows "Connected as @your-username". Done — the token is stored in dsh's credential store, never in a config file.

**Option B — token (CLI / headless / CI):**

Set the `GITHUB_TOKEN` environment variable, or add the token to your `.credentials.yaml`. The provider resolves credentials on every operation, so swapping the token requires no restart.

For GitHub Enterprise Server, additionally point the provider at your instance via its `baseURL` setting.

### 3. Verify

```bash
export DEEPSEEK_API_KEY=sk-…
export GITHUB_TOKEN=ghp_…
dsh --profile headless "search GitHub for open issues in octocat/Hello-World"
```

The read tools work as soon as credentials resolve. In the web profile, the PR status bar appears automatically once the current project's git remote points at GitHub and your branch is ahead of its base.

## Roadmap

1. Seam + REST provider + read tools (CLI-usable with `GITHUB_TOKEN`)
2. Write tools + approval integration
3. Device Flow connect + settings UI
4. Composer PR bar (create / AI review / merge)
5. Token refresh, PR review (approve / request changes), GraphQL — later

## License

[MIT](LICENSE)
