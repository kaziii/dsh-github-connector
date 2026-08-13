# dsh-github-rest

English | [中文](README.zh.md)

The **REST v3 provider** for [`dsh-github`](../github/README.md): plain platform `fetch` (ADR-0006, no octokit), registered into `ctx.github` as provider id **`rest`**. It maps the v1 endpoint set onto the seam's normalized vocabulary and keeps every policy the seam contract demands: per-operation credential resolution, honest truncation, no built-in retries.

| Package | Role |
|---|---|
| `dsh-github` | Service Definition: `ctx.github`, vocabulary, selection, `GitHubError` |
| `dsh-github-rest` (this) | Provider: REST v3 transport, auth, pagination, rate-limit/error mapping, idempotent PR creation, GHES `baseURL` |
| `dsh-tool-github` | Consumer: the model-facing `github_*` tools (M3/M4) |

## Configuration

| Field | Default | Semantics |
|---|---|---|
| `credentialRef` | `GITHUB_TOKEN` | Environment-variable NAME the token resolves through — a reference, never the secret itself, so the settings document stays token-free. |
| `baseURL` | `https://api.github.com` | API root. Point it at `https://ghes.example.com/api/v3` for GitHub Enterprise Server; trailing slashes are tolerated. |

The config doubles as the `github-rest` settings section (`installSettingsSection`): while a settings seam is mounted, user changes apply LIVE — both fields are re-read on every operation — and when it detaches, the composition entry config takes over again.

## Credential resolution

Resolved fresh on EVERY operation (a rotated token reaches the next call without restart): the optional credentials seam (`ctx.get('credentials')`) wins when mounted and configured; the process environment is the fallback either way — the CLI path of exporting `GITHUB_TOKEN` just works with no seam mounted. `available()` stays a cheap local check (seam mounted, or env value non-blank) and never touches the network; an unconfigured credential surfaces per-operation as `GITHUB_AUTH`.

## Transport policy

- **Pagination**: `Link`-header following with a hard cap of 10 pages; comments, diff files, and check runs aggregate across pages. Diff reads stop early once a `maxFiles` budget is satisfiable and report `truncated` honestly (ADR-0005 — the seam still enforces the budgets).
- **Rate limits**: 403/429 carrying `retry-after` or an exhausted primary quota map to `GITHUB_RATE_LIMITED { retryAfterMs }`. The provider NEVER retries — the caller owns that decision (seam contract).
- **Error mapping**: 401 → `GITHUB_AUTH`, 404 → `GITHUB_NOT_FOUND`, 422 → `GITHUB_VALIDATION` (API message preserved verbatim), abort → `GITHUB_ABORTED`, transport failure → `GITHUB_PROVIDER_NETWORK`, everything else → `GITHUB_PROVIDER_HTTP`.
- **Idempotent PR creation** (ADR-0004): look up the open PR for the exact head/base first (`created: false` on a hit), POST on a miss, and on a lost race (422 "already exists") look up once more and return the winner's PR.

## Testing

`tests/github-rest.spec.ts` replays recorded fixture responses through an injected `fetch` — the whole suite runs keyless. `tests/github-rest.e2e.ts` is the real-API read-only smoke and self-skips without `GITHUB_TOKEN` (`pnpm test:e2e`).

## Model Experience

Indirectly, through `dsh-tool-github`: the model sees the seam's normalized shapes and error codes, never this transport. What this package guarantees the model is policy fidelity — honest `truncated` flags, verbatim validation messages, and `retryAfterMs` on rate limits so the tool layer can render a useful "try again later".
