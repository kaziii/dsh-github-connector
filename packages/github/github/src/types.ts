/**
 * Vocabulary for the GitHub capability seam (`ctx.github`). Reads and writes deliberately share
 * one seam and one provider interface so identity, credentials, rate-limit budget, and errors
 * have a single owner (ADR-0003).
 * @module dsh-github/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Addressing: one repository. Both halves are non-blank (seam-validated). */
export interface GitHubRepoRef {
  readonly owner: string
  readonly repo: string
}

/**
 * Addressing: one issue or pull request. `repo` + `number` is the portable
 * handle the model passes between tools; `url` is display-only and optional
 * because a model-composed handle may not carry one.
 */
export interface GitHubItemRef {
  readonly repo: GitHubRepoRef
  readonly number: number
  readonly url?: string
}

/** Issue lifecycle state. */
export type GitHubIssueState = 'open' | 'closed'

/**
 * Pull request lifecycle state. `merged` is first-class rather than a boolean
 * on `closed`: consumers routinely branch on it (flow-state stage 3) and a
 * closed-unmerged PR is a materially different outcome.
 */
export type GitHubPullRequestState = 'open' | 'closed' | 'merged'

/** Normalized issue read shape. Optional fields are provider-supplied when the API returns them. */
export interface GitHubIssue {
  readonly ref: GitHubItemRef
  readonly title: string
  readonly state: GitHubIssueState
  readonly body?: string
  readonly author?: string
  readonly labels?: readonly string[]
  /** ISO-8601 timestamps as returned by the provider. */
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly commentCount?: number
}

/**
 * Normalized pull request read shape. Diff and checks are deliberately NOT
 * embedded: they are separate on-demand operations ({@link GitHubProvider})
 * so reading PR metadata never pays their cost.
 */
export interface GitHubPullRequest {
  readonly ref: GitHubItemRef
  readonly title: string
  readonly state: GitHubPullRequestState
  /** Target branch name (e.g. `main`). */
  readonly baseRef: string
  /** Source branch name (e.g. `feat/xxx`). */
  readonly headRef: string
  readonly body?: string
  readonly author?: string
  readonly draft?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly commentCount?: number
}

/** One conversation comment on an issue or pull request. */
export interface GitHubComment {
  readonly id: number
  readonly body: string
  readonly author?: string
  readonly createdAt?: string
  readonly url?: string
}

/** File-level change status within a diff, as reported by the provider. */
export type GitHubDiffFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'

/** One changed file within a pull request diff. `patch` is absent for binary or budget-dropped files. */
export interface GitHubDiffFile {
  readonly path: string
  /** Previous path for renames/copies. */
  readonly previousPath?: string
  readonly status: GitHubDiffFileStatus
  readonly additions: number
  readonly deletions: number
  /** Unified-diff hunk text; absent when unavailable or dropped by budget. */
  readonly patch?: string
}

/**
 * A pull request diff. `truncated` is honest (ADR-0005): true whenever ANY
 * reduction happened — by the provider (pre-truncated is allowed) or by the
 * seam enforcing {@link GitHubDiffRequest} budgets.
 */
export interface GitHubDiff {
  readonly files: readonly GitHubDiffFile[]
  readonly truncated: boolean
}

/**
 * Diff budgets. The consumer (tool layer) owns the numbers and passes them in;
 * the seam enforces them in one place (ADR-0005). Omitted = unbounded.
 * `maxPatchChars` bounds the TOTAL patch characters across the whole diff.
 */
export interface GitHubDiffRequest {
  readonly maxFiles?: number
  readonly maxPatchChars?: number
}

/** Check-run execution status. */
export type GitHubCheckStatus = 'queued' | 'in_progress' | 'completed'

/** Check-run conclusion once completed. */
export type GitHubCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'

/** One CI check run on a pull request head. */
export interface GitHubCheckRun {
  readonly name: string
  readonly status: GitHubCheckStatus
  readonly conclusion?: GitHubCheckConclusion
  readonly url?: string
}

/** All check runs for a pull request head commit. */
export interface GitHubChecksResult {
  readonly runs: readonly GitHubCheckRun[]
}

/**
 * What one search targets. A CLOSED union owned by `dsh-github`: consumers
 * `switch` on it ending in `default: assertNever(...)` so a new kind breaks
 * compilation at every consumer until handled.
 */
export type GitHubSearchKind = 'issues' | 'pull-requests' | 'repositories' | 'code'

/**
 * One search. `maxResults` is a consumer-layer bound passed through unchanged
 * and enforced on the way back by the seam (see {@link GitHubSearchResult}).
 */
export interface GitHubSearchRequest {
  readonly kind: GitHubSearchKind
  readonly query: string
  /** Upper bound on returned items; the seam truncates to it. Omitted = no bound. */
  readonly maxResults?: number
}

/**
 * One search hit, deliberately lean (title/number/state/URL) to control model
 * token spend. `repo` + `number` are present for issue/PR hits so the result
 * doubles as a portable {@link GitHubItemRef} handle.
 */
export interface GitHubSearchItem {
  readonly title: string
  readonly url: string
  readonly repo?: GitHubRepoRef
  readonly number?: number
  readonly state?: string
  readonly snippet?: string
}

/** Normalized search outcome. `truncated` is set by the seam when it cut `items[]` down to `maxResults`. */
export interface GitHubSearchResult {
  readonly items: readonly GitHubSearchItem[]
  readonly truncated: boolean
}

/** Create one issue. */
export interface GitHubIssueCreateRequest {
  readonly repo: GitHubRepoRef
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
}

/** Create one conversation comment on an issue or pull request. */
export interface GitHubCommentCreateRequest {
  readonly item: GitHubItemRef
  readonly body: string
}

/** Create one pull request. `head`/`base` are branch names. */
export interface GitHubPullRequestCreateRequest {
  readonly repo: GitHubRepoRef
  readonly title: string
  readonly head: string
  readonly base: string
  readonly body?: string
  readonly draft?: boolean
}

/**
 * Idempotent PR-creation outcome (ADR-0004): when an open PR for the same
 * head/base already exists, providers return it with `created: false` instead
 * of failing.
 */
export interface GitHubPullRequestCreateResult {
  readonly pullRequest: GitHubPullRequest
  readonly created: boolean
}

/**
 * A GitHub backend. Registered with `ctx.github.registerProvider`. One
 * provider owns ALL operations — reads and writes share identity, credentials,
 * and rate-limit budget (ADR-0003). `id` is a stable string, unique within
 * the registry.
 *
 * Diff contract (ADR-0005): `getDiff` receives the budget so it MAY optimize
 * (fetch less), and may return the diff full or pre-truncated; the seam
 * enforces the budget either way and keeps `truncated` honest.
 */
export interface GitHubProvider {
  readonly id: string
  /** Cheap local usability check (credential ref resolvable); must not make network calls. */
  available(): boolean
  search(request: GitHubSearchRequest, signal?: AbortSignal): Promise<GitHubSearchResult>
  getIssue(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubIssue>
  getPullRequest(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubPullRequest>
  /** Aggregated conversation comments for an issue or pull request. */
  getComments(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubComment[]>
  getDiff(item: GitHubItemRef, request: GitHubDiffRequest, signal?: AbortSignal): Promise<GitHubDiff>
  /** Check runs for the pull request's head commit. */
  getChecks(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubChecksResult>
  createIssue(request: GitHubIssueCreateRequest, signal?: AbortSignal): Promise<GitHubIssue>
  createComment(request: GitHubCommentCreateRequest, signal?: AbortSignal): Promise<GitHubComment>
  createPullRequest(request: GitHubPullRequestCreateRequest, signal?: AbortSignal): Promise<GitHubPullRequestCreateResult>
}

/** Construction options for {@link GitHubError}; `retryAfterMs` accompanies `GITHUB_RATE_LIMITED`. */
export interface GitHubErrorOptions extends ErrorOptions {
  /** Milliseconds the caller should wait before retrying (rate limits). */
  readonly retryAfterMs?: number
}

/**
 * Typed GitHub error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes:
 * `GITHUB_AUTH`, `GITHUB_RATE_LIMITED` (carries {@link retryAfterMs}),
 * `GITHUB_NOT_FOUND`, `GITHUB_VALIDATION`, `GITHUB_ABORTED`, and the
 * `GITHUB_PROVIDER_*` family for registry/selection and provider transport
 * failures.
 */
export class GitHubError extends HarnessError {
  /** Milliseconds the caller should wait before retrying; set with `GITHUB_RATE_LIMITED`. */
  readonly retryAfterMs?: number

  constructor(message: string, code: string, options?: GitHubErrorOptions) {
    super(message, code, options)
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}
