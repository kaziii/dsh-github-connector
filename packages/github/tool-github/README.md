# dsh-tool-github

English | [中文](README.zh.md)

The **model-facing `github_*` tool suite** over [`dsh-github`](../github/README.md) (`ctx.github`). This package owns schemas, validation, prompt guidance, tool-layer budgets, and presentation — never providers, transport, or credentials.

| Tool | What it does |
|---|---|
| `github_search` | Search issues / pull-requests / repositories / code (CLOSED kind union). Lean hits: `owner/repo#N [state] title` + URL. |
| `github_issue_read` | Title, state, labels, body, plus capped aggregated comments. |
| `github_pr_read` | Split into on-demand parts: `metadata` (default) / `diff` / `comments` / `checks` — one call never pays for data the model did not ask for. |
| `github_issue_create` | Write, approval-gated. |
| `github_issue_comment` | Write, approval-gated. |
| `github_pr_create` | Write, approval-gated, idempotent (an already-open PR for the same head/base is a normal answer, not an error). |

## Configuration

| Field | Default | Semantics |
|---|---|---|
| `write` | `true` | Register the three write tools. Off = they are absent from the tool catalog entirely. |
| `searchMaxResults` | `8` | Cap on hits per search (search API rate budget is scarce: 30 req/min). |
| `maxComments` | `30` | Cap on returned conversation comments per read. |
| `diffMaxFiles` / `diffMaxPatchChars` | `50` / `60000` | **Tool-owned** diff budgets (ADR-0005): held here, passed to the seam, enforced there. |
| `timeoutMs` | `30000` | Cooperative timeout attached to every tool (`dsh-timeout-policy` enforces). |

## Approval flow (writes)

Every write returns `ask` from `tools/pre-execute` with a human-readable reason naming the target repo, title, and a body preview — exactly what the host's ApprovalPanel renders. The registry resolves the ask through the optional approval seam: `allowed-once` proceeds; rejection, cancellation, and an absent approval channel each materialize a distinct model-visible refusal result (never an exception), so the model can explain and continue. Read tools pass the gate untouched.

## Presentation

`presentCall` / `presentResult` are pure and replay-safe: reads render as `read`/`search` cards, writes as `edit` cards; `github_pr_create` presents `created: false` as "PR #N already open". Result meta is narrowed defensively — malformed replay meta falls back to the generic card instead of throwing.

## Errors the model can act on

Seam failures are translated at the tool boundary: rate limits become a wait-and-retry hint carrying `retryAfterMs` (and a nudge toward direct reads over search), auth failures name the fix (connect GitHub / set `GITHUB_TOKEN`), not-found points at the handle. Diff truncation is surfaced with a "narrow the scope" hint.

## Model Experience

The model sees six tools with strict, small schemas; portable `owner/repo` + `number` handles that flow between search hits and reads; lean text renderings tuned for token spend; honest truncation markers with recovery hints; and write refusals phrased as answers. The system prompt section teaches the part-split PR read and the approval semantics up front.
