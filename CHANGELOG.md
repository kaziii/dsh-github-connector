# Changelog

## Unreleased

The dsh client adapter (ADR-0008/ADR-0009), landing the real web-deployment path for `dsh-ui-github`:

- **Polling instead of forwarded events (ADR-0009)** — dsh forwards no custom host events to the browser, so the UI now drives itself: the connect card polls the new `@Remote deviceFlowStatus()` at the server-dictated pace (a superseded flow's updates are dropped host-side), and the status bar polls `refreshFlowState` with backoff, pauses while hidden, keeps open dropdowns and drafts across unchanged rounds, folds CI changes into the badge in place, and remembers a collapsed merged banner. The Typert event selection narrows to `credentials/updated`.
- **`dsh-ui-github/client` (ADR-0008)** — the shipped dsh client half: `dsh.client` manifest + `exports["./client"]`, an empty node `apply` anchored by the package's own `cordis.patch.yml` (so `dsh plugin add` wires the whole UI), a hand-written strict `githubConnect` Typert contribution self-mounted through `ctx.remote.$mount` (no dsh-repo change), the browser shell adapter (plugin-config card, session-scoped [AI review] prompt, http(s)-only external links, clipboard, visibility), and `lib/client.js` built as the dsh CJS closure factory (`scripts/build-client-bundle.ts`, esbuild).

## 0.1.0 (2026-08-14) — v1

First implemented release of the dsh GitHub connector: milestones M1–M7 of the [execution plan](docs/plans/execution-plan.md), against the [v1 design](docs/design/design.md). All packages ship at `0.1.0`.

### Packages

- **`dsh-github`** — the `ctx.github` capability seam: normalized vocabulary (repo/item refs, issue/PR/comment/diff/checks shapes, closed search-kind union), provider registry (effect + disposer, per-operation resolution), `GitHubError` taxonomy, and seam-enforced diff budgets with an honest `truncated` flag (ADR-0005).
- **`dsh-github-rest`** — REST v3 provider over plain `fetch` (ADR-0006): per-operation credential resolution (credentials seam with process-env fallback), Link-header pagination with an internal page cap, rate-limit mapping to `GITHUB_RATE_LIMITED { retryAfterMs }`, full HTTP→error-code map, GHES `baseURL`, idempotent PR creation with the 422-race fallback (ADR-0004), and a user-settings section storing only the credential reference.
- **`dsh-tool-github`** — the model-facing suite: `github_search`, `github_issue_read`, `github_pr_read` (diff/comments/checks as on-demand sub-reads, tool-owned budgets), plus write tools `github_issue_create`, `github_issue_comment`, `github_pr_create` behind the `write` switch and the `tools/pre-execute` approval gate. Pure `presentCall`/`presentResult` for session replay.
- **`dsh-github-connect`** — Device Flow authorization storing the token through the credentials seam (ADR-0001), deterministic git flow-state detection after each agent turn (ADR-0002) pushed over `github/flow-state`, and the zero-model-turn `@Remote` methods: `connectStatus`, `startDeviceFlow`, `disconnect`, `createPr`, `mergePr`, `prChecks`, `refreshFlowState`.
- **`dsh-ui-github`** — the web client's two slot fills: the Connect GitHub settings section and the three-stage conversation PR status bar, with frontend CI-badge polling (backoff, paused while hidden) and full en/zh-CN catalogs. Bound to the client shell through an injected port (ADR-0007).

### Tooling

- `pnpm build` — `tsc -b` plus entry shims, making every package resolvable at `lib/` for scripts and examples.
- `pnpm gen:catalog` / `pnpm gate:catalog` — the tool-catalog boot manifest (`scripts/gen-tool-catalog.ts` → `tool-catalog.json`) snapshotting every registered model tool per config variant, with a drift gate.
- `examples/github-quickstart` — runnable CLI + token path (seam, tool execution, flow-state detection on the host repository) and the compile-checked web-client UI wiring shape.

### Known gaps (tracked, not regressions)

- Two manual acceptance items stay pending until a dsh host environment (and its client-shell adapter) is available: the M3 CLI walkthrough and the M6 end-to-end UI script (recorded in PR #5's description).
- v1 scope exclusions per design §10: PR reviews, merge queue, branch/file reads, reactions, GraphQL, token auto-refresh (`ghu_` expiry — v1 uses non-expiring authorization).
