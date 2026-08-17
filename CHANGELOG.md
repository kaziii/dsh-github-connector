# Changelog

## dsh-github-connect 0.1.1 (2026-08-14)

- **Zero-setup Device Flow** — `clientId` now defaults to the project's shared `dsh-github-connector` OAuth App (`DEFAULT_CLIENT_ID`, Device Flow enabled), so a fresh install connects without any configuration — the same ship-the-public-client-id pattern the GitHub CLI uses. GHES deployments still override it with an App registered on their own instance.

## dsh-ui-github 0.1.1 (2026-08-14)

- **Fix: namespace access without inject** — the client half handed `ctx.remote` straight to the React surfaces, so their first `remote.githubConnect` access re-entered the cordis inject check and threw `cannot get property "remote.githubConnect" without inject` (the plugin mounts that namespace itself and must not inject it — ADR-0008). The surfaces now receive a thin face that resolves the namespace per access through inject-free `ctx.get('remote.githubConnect')`, with `$on` still riding the injected gateway service.

## Unreleased

M10 — the write half of the review loop, closing v2:

- **`github_pr_review_submit`** posts a review with inline comments. `APPROVE` and `REQUEST_CHANGES` are gated by a new `reviewVerdicts` switch that **defaults to false** (ADR-0014): with it off, those events are absent from the schema entirely, so the model never sees that approving is possible. This is the project's first operation with a social consequence — it goes out under the user's own account and changes whether a PR is blocked — and a per-call approval prompt is the wrong last line of defence against approval fatigue.
- **`github_pr_update` / `github_pr_assign` / `github_pr_list`** — title, body, base retarget, open/closed; reviewer requests and labels (add or replace); a capped listing. The first two are approval-gated writes; the listing is a read and survives `write: false`.
- **Merge pre-check** — `mergePr` now reads mergeability first and, when GitHub already knows the merge cannot succeed, returns the blockers **without sending the PUT**. The status bar shows them in place. A doomed merge should read as "cannot merge because X", not as an opaque failure after the fact.
- **Self-approval, explained** — GitHub refuses `APPROVE` on your own PR with a terse 422; the provider rewrites it into a sentence saying so, since the status bar's own [AI review] path is exactly that case.
- **Catalog snapshots now carry closed enums** (`event:COMMENT` vs `event:COMMENT|APPROVE|REQUEST_CHANGES`). Names alone made two variants differing only in an enum look identical — precisely the drift the new `verdicts-on` variant exists to catch.

Two constraints found while building it, both recorded in the execution plan: dsh's `PreToolDecision` carries only a reason string with no risk level, so ADR-0014's "forced-checkbox confirmation" degrades to wording (the capability switch remains the real defence); and REST cannot flip draft↔ready at all, so that field left the interface.

M9 — `github_pr_review` (ADR-0013), replacing the one-line "review this PR" prompt with a task that has a known shape:

- **Deterministic dimension routing** — `classifyFile` / `changedLines` / `routeDimensions` in the seam decide which of the six axes (correctness, tests, error-handling, types, comments, simplification) this particular change warrants. Keyword probes read only `+`/`-` lines, never context, so a `catch` the author merely scrolled past cannot route a whole review through error handling. A docs-only PR is never asked about type design. Routing earns its keep by *excluding* what would arrive empty, not by distributing axes evenly.
- **One diff, N dimensions** — `GitHubReviewBrief` carries the diff exactly once and each dimension references its `paths`. Six axes over one diff cost one diff. The severity vocabulary and the finding contract are likewise global, not repeated per axis.
- **Evidence, not verdict** — the tool ships no score and no opinion. What it guarantees is coverage and output shape: every finding must carry a `path:line`, one severity from a fixed scale, and what/why/proposed-change. The judgement stays the model's.
- **Status bar wiring** — the [AI review] button's prompt now routes through the tool and explicitly does *not* ask for the review to be submitted to GitHub; that stays the user's next word (ADR-0014).

M8 — the read half of the v2 review loop (ADR-0012), so the model can act on review feedback and on CI failures instead of merely observing that they exist:

- **Review reads** — `getReviews` / `getReviewComments` on the seam and provider, plus `github_pr_read part=reviews`. Line-anchored review comments come from `/pulls/{n}/comments`, which v1 never touched: it only read the issue-level thread, so everything reviewers wrote *on the code* was invisible. `GitHubReviewComment` stays a separate type from `GitHubComment` — it carries a path and a line, and you act on it by editing that code. An outdated comment (line gone) renders with its diff hunk, the only anchor it has left. Thread `resolved` state is absent by design: GraphQL-only, still out of scope.
- **CI failure evidence (ADR-0015)** — `getCheckFailures` and `github_pr_read part=ci-failures` answer *why* a check failed. Structured check-run annotations come first; a job log is fetched only when a failed run reported none (or `includeLogs` asks for it), and only its **tail** survives, under tool-owned `logMaxLines` / `logMaxChars` budgets the seam enforces (the ADR-0005 mechanism). The character cut realigns forward to a line start, except when the whole budget lands inside one line — a truncated line still names the failure, an empty log names nothing.
- **Log transport** — `restTextRequest` handles the non-JSON endpoint and follows the redirect to object storage **manually and without the `Authorization` header**: the signed URL carries its own grant, and forwarding the user's token to a storage host would leak it. HTTP 410 now maps to `GITHUB_NOT_FOUND` alongside 404 — an expired Actions log is an absence, not a transport fault, and it degrades to "no evidence for this run" rather than failing the whole read.
- **Honest truncation, upward** — a log the provider already truncated marks the entire failure result truncated even when no budget applies at the seam, so `truncated` can never under-report.

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
