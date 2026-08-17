# dsh-github

English | [中文](README.zh.md)

The **`GitHubRuntime`** (`ctx.github`) defines WHAT GitHub access the harness has — search, read issues/PRs/diffs/checks, create issues/comments/PRs — over registered providers, without binding the model contract to one transport's API shape.

This package owns the Service Definition role of the GitHub capability (design: [docs/design/design.md](../../../docs/design/design.md), §3–§4):

| Package | Role |
|---|---|
| `dsh-github` (this) | Service Definition: the service, provider registry, selection policy, read/write vocabulary, seam-enforced diff budgets, the `GitHubError` taxonomy |
| `dsh-github-rest` | Provider: GitHub REST v3 via `fetch` (M2) |
| `dsh-tool-github` | Consumer: the model-facing `github_*` tool schemas over `ctx.github` (M3/M4) |

Reads and writes are deliberately ONE provider interface (ADR-0003): they share identity, credentials, and rate-limit budget, so splitting them would let authentication state diverge.

## Service API (`ctx.github`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Register a backend. Throws `GitHubError` `GITHUB_PROVIDER_DUPLICATE` on a duplicate id. Returns a disposer. Disposed with the calling fiber. |
| `search(request, signal?)` | Resolve the provider and run one search. Enforces `request.maxResults` on the result (truncates `items[]`, sets `truncated`). |
| `getIssue` / `getPullRequest` / `getComments` / `getChecks` | Normalized on-demand reads. PR metadata never embeds diff or checks — they are separate calls. |
| `getDiff(item, request?, signal?)` | Read a PR diff, enforcing the consumer-owned `maxFiles` / `maxPatchChars` budgets at the seam (ADR-0005). `truncated` is honest: true whenever ANY reduction happened, provider-side or seam-side. |
| `getReviews` / `getReviewComments` | Submitted review verdicts, and the line-anchored comments they carry. `GitHubReviewComment` is deliberately NOT `GitHubComment`: it has a path and a line, and you act on it by editing that code. |
| `getCheckFailures(item, request?, signal?)` | Why the failing checks failed: annotations when the CI tool reported them, otherwise a log **tail** under the consumer-owned `maxLogLines` / `maxLogChars` budgets (ADR-0015). Same honesty rule as `getDiff` — a provider-truncated log alone marks the whole result truncated. |
| `createIssue` / `createComment` / `createPullRequest` | Writes. PR creation is idempotent (ADR-0004): an existing open PR for the same head/base comes back with `created: false`. |

Providers register **capabilities**, not tools. `dsh-tool-github` is the only owner of model-facing names, descriptions, prompt guidance, JSON schemas, and presentation.

## Selection

Selection never depends on registration, config, or HMR order. Either an explicit provider id is configured (config `provider`, or env `$DSH_GITHUB_PROVIDER` feeding the same field), or exactly one usable provider auto-selects. Operations resolve the provider at execution time, on EVERY call — never cached — so a credential change flips `available()` without restart:

| Situation | Execution |
|---|---|
| configured id registered and `available()` | runs that provider |
| configured id not registered | `GITHUB_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `GITHUB_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `GITHUB_PROVIDER_AMBIGUOUS` |

A provider's `available()` is a cheap local check (credential ref resolvable) and **must not make network calls**.

## Vocabulary

`GitHubRepoRef` (`owner`, `repo`) and `GitHubItemRef` (`repo`, `number`, `url?`) are the portable handles the model passes between tools. Read shapes: `GitHubIssue`, `GitHubPullRequest` (`merged` is a first-class state), `GitHubComment`, `GitHubDiff` (`files[]`, `truncated`), `GitHubChecksResult`. `GitHubSearchKind` is a CLOSED union (`issues` | `pull-requests` | `repositories` | `code`) — consumers `switch` to exhaustiveness. Writes: `GitHubIssueCreateRequest`, `GitHubCommentCreateRequest`, `GitHubPullRequestCreateRequest` → `GitHubPullRequestCreateResult` (`pullRequest`, `created`). The seam validates refs (non-blank owner/repo, positive-integer numbers) and budget parameters as `GITHUB_VALIDATION`. See `src/types.ts` for the full contracts and the `GitHubError` code taxonomy (`GITHUB_AUTH`, `GITHUB_RATE_LIMITED` + `retryAfterMs`, `GITHUB_NOT_FOUND`, `GITHUB_VALIDATION`, `GITHUB_ABORTED`, `GITHUB_PROVIDER_*`).

## Model Experience

Indirectly, through `dsh-tool-github`, which renders bounded normalized GitHub data or the structured failure codes above (rate limits surface a retry-after hint); this registry contributes no prompt or schema itself.
