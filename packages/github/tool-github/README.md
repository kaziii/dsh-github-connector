# dsh-tool-github

English | [中文](README.zh.md)

The **model-facing `github_*` tool suite** over [`dsh-github`](../github/README.md) (`ctx.github`). This package owns schemas, validation, prompt guidance, tool-layer budgets, and presentation — never providers, transport, or credentials.

| Tool | What it does |
|---|---|
| `github_search` | Search issues / pull-requests / repositories / code (CLOSED kind union). Lean hits: `owner/repo#N [state] title` + URL. |
| `github_issue_read` | Title, state, labels, body, plus capped aggregated comments. |
| `github_pr_read` | Split into on-demand parts: `metadata` (default) / `diff` / `comments` / `reviews` / `checks` / `ci-failures` — one call never pays for data the model did not ask for. |
| `github_pr_review` | Assemble the structured review task for one PR: diff (once), the dimensions that apply to these changes, each one's checklist, the severity scale, and the finding contract. Evidence and a contract — not a verdict (ADR-0013). |
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
| `logMaxLines` / `logMaxChars` | `80` / `8000` | **Tool-owned** CI log budgets, same mechanism. Only ever applied to a log TAIL (ADR-0015). |
| `reviewMaxFiles` / `reviewMaxPatchChars` | `60` / `120000` | **Tool-owned** review-brief budgets. Deliberately their own numbers, not the diff budgets above: a review reads wider than a plain diff read (ADR-0013). |
| `timeoutMs` | `30000` | Cooperative timeout attached to every tool (`dsh-timeout-policy` enforces). |

## Approval flow (writes)

Every write returns `ask` from `tools/pre-execute` with a human-readable reason naming the target repo, title, and a body preview — exactly what the host's ApprovalPanel renders. The registry resolves the ask through the optional approval seam: `allowed-once` proceeds; rejection, cancellation, and an absent approval channel each materialize a distinct model-visible refusal result (never an exception), so the model can explain and continue. Read tools pass the gate untouched.

## Presentation

`presentCall` / `presentResult` are pure and replay-safe: reads render as `read`/`search` cards, writes as `edit` cards; `github_pr_create` presents `created: false` as "PR #N already open". Result meta is narrowed defensively — malformed replay meta falls back to the generic card instead of throwing.

## Errors the model can act on

Seam failures are translated at the tool boundary: rate limits become a wait-and-retry hint carrying `retryAfterMs` (and a nudge toward direct reads over search), auth failures name the fix (connect GitHub / set `GITHUB_TOKEN`), not-found points at the handle. Diff truncation is surfaced with a "narrow the scope" hint.

## Model Experience

The model sees six tools with strict, small schemas; portable `owner/repo` + `number` handles that flow between search hits and reads; lean text renderings tuned for token spend; honest truncation markers with recovery hints; and write refusals phrased as answers. The system prompt section teaches the part-split PR read and the approval semantics up front.

`github_pr_review` is the one tool that hands the model a **task shape** rather than data. Asked to "review this PR", a model left to itself reads the diff and improvises: coverage varies run to run, severity is ad hoc, and findings arrive without a line to point at. The tool replaces that with a brief whose dimensions were **routed deterministically from the change itself** — a docs-only PR is never asked about type design — each carrying a checklist, plus one fixed severity vocabulary and a contract every finding must meet. It ships no verdict and no score: the coverage and the shape are guaranteed, the judgement stays the model's (ADR-0013).

Two parts exist so the model can close a loop rather than merely observe one. `part=reviews` returns the verdicts AND the line-anchored comments — rendered as `path:line · author (side): body`, which is directly actionable, unlike an issue-level comment thread. A comment whose line is gone (outdated) carries its diff hunk instead, because that is the only anchor left. `part=ci-failures` answers *why* a check failed: structured annotations when the CI tool reported them, otherwise a budgeted log **tail** — never a head, since failures surface at the end. When neither exists the model is told so plainly instead of being handed an empty block.
