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
 * Verdict of one submitted review. `pending` is a review its author started but
 * has not submitted — visible only to that author, and carried here because the
 * API returns it for the authenticated user.
 */
export type GitHubReviewState = 'commented' | 'approved' | 'changes-requested' | 'dismissed' | 'pending'

/**
 * One submitted review on a pull request — the verdict-bearing wrapper around a
 * batch of {@link GitHubReviewComment}s. Distinct from {@link GitHubComment}:
 * that one is a conversation post with no verdict.
 */
export interface GitHubReview {
  readonly id: number
  readonly state: GitHubReviewState
  readonly author?: string
  readonly body?: string
  readonly submittedAt?: string
  readonly url?: string
}

/** Which side of the diff a review comment is anchored to. */
export type GitHubReviewSide = 'left' | 'right'

/**
 * One review comment anchored to a line of the diff. Deliberately NOT merged
 * with {@link GitHubComment}: this one carries a file path and line, and a
 * consumer acts on it by editing that code — a materially different shape and
 * use than an issue-level conversation post.
 *
 * Thread resolution state is absent on purpose: it exists only in GraphQL,
 * which stays out of scope (design §10).
 */
export interface GitHubReviewComment {
  readonly id: number
  readonly path: string
  readonly body: string
  readonly side: GitHubReviewSide
  /** Line in the file the comment anchors to; absent when the comment is outdated. */
  readonly line?: number
  /** The diff hunk the comment was left on, as returned by the provider. */
  readonly diffHunk?: string
  readonly author?: string
  readonly createdAt?: string
  readonly url?: string
  /** Set when this comment replies to another in the same thread. */
  readonly inReplyToId?: number
}

/** Severity a CI tool assigned to one annotation. */
export type GitHubAnnotationLevel = 'notice' | 'warning' | 'failure'

/**
 * One structured finding a check run reported against a file. This is the
 * preferred failure evidence (ADR-0015): a CI tool already reduced its output
 * to `path:line + message`, so no log scraping is needed.
 */
export interface GitHubCheckAnnotation {
  readonly path: string
  readonly level: GitHubAnnotationLevel
  readonly message: string
  readonly title?: string
  readonly startLine?: number
  readonly endLine?: number
}

/**
 * The tail of a failed job's log. Only ever a TAIL: failure evidence (stack
 * traces, summaries, exit codes) sits at the end, while the head is install and
 * build noise.
 */
export interface GitHubCheckLog {
  readonly text: string
  readonly truncated: boolean
}

/** One failed check run with whatever evidence was obtainable for it. */
export interface GitHubCheckFailure {
  readonly run: GitHubCheckRun
  readonly annotations: readonly GitHubCheckAnnotation[]
  /** Present only when annotations were absent or logs were explicitly requested (ADR-0015). */
  readonly log?: GitHubCheckLog
}

/**
 * All failing check runs of a pull request head. `truncated` is honest in the
 * same sense as {@link GitHubDiff}: true whenever ANY reduction happened —
 * a dropped annotation page or a cut log tail.
 */
export interface GitHubCheckFailuresResult {
  readonly failures: readonly GitHubCheckFailure[]
  readonly truncated: boolean
}

/**
 * Budgets and mode for a failure read. Like {@link GitHubDiffRequest}, the
 * consumer owns the numbers and the seam enforces them in one place (ADR-0005).
 * Omitted budgets = unbounded.
 */
export interface GitHubCheckFailureRequest {
  /** Keep at most this many trailing log lines. */
  readonly maxLogLines?: number
  /** Keep at most this many trailing log characters. */
  readonly maxLogChars?: number
  /**
   * Fetch job logs even for runs that already reported annotations. Default
   * (false) follows ADR-0015: annotations first, logs only on a miss.
   */
  readonly includeLogs?: boolean
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
 * What submitting a review DOES. `COMMENT` leaves opinion; the other two carry
 * social consequence — they change a PR's blocking state under the user's own
 * name — which is why the tool layer gates them behind an explicit opt-in
 * (ADR-0014).
 */
export type GitHubReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/** One inline comment to leave as part of a submitted review. */
export interface GitHubReviewCommentDraft {
  readonly path: string
  /** Line in the file's post-change state (or pre-change when `side` is `left`). */
  readonly line: number
  readonly side?: GitHubReviewSide
  readonly body: string
}

/** Submit one review: a verdict, an optional summary, and optional inline comments. */
export interface GitHubReviewSubmitRequest {
  readonly item: GitHubItemRef
  readonly event: GitHubReviewEvent
  readonly body?: string
  readonly comments?: readonly GitHubReviewCommentDraft[]
}

/**
 * Update one pull request's own fields.
 *
 * Draft↔ready is deliberately absent: REST cannot flip it (GitHub exposes
 * `markPullRequestReadyForReview` only through GraphQL, which stays out of
 * scope per design §10).
 */
export interface GitHubPullRequestUpdateRequest {
  readonly item: GitHubItemRef
  readonly title?: string
  readonly body?: string
  /** Retarget the PR at a different base branch. */
  readonly base?: string
  readonly state?: 'open' | 'closed'
}

/** Request review from users and/or teams. */
export interface GitHubReviewersRequest {
  readonly item: GitHubItemRef
  readonly reviewers?: readonly string[]
  readonly teamReviewers?: readonly string[]
}

/** Apply labels, either adding to or replacing the current set. */
export interface GitHubLabelsRequest {
  readonly item: GitHubItemRef
  readonly labels: readonly string[]
  /** `add` keeps existing labels (default); `set` replaces them wholesale. */
  readonly mode?: 'add' | 'set'
}

/** List pull requests of one repository. */
export interface GitHubPullRequestListRequest {
  readonly repo: GitHubRepoRef
  readonly state?: 'open' | 'closed' | 'all'
  /** Filter by head branch (bare name; the provider qualifies it with the owner). */
  readonly head?: string
  readonly base?: string
  readonly maxResults?: number
}

/**
 * GitHub's merge-readiness verdict for one pull request.
 *
 * `clean` merges; `dirty` has conflicts; `blocked` fails a branch-protection
 * requirement; `unstable` has a failing non-required check; `behind` needs the
 * base merged in; `draft` is not ready by definition. `unknown` is GitHub still
 * computing — it is NOT permission to merge.
 */
export type GitHubMergeableState = 'clean' | 'blocked' | 'dirty' | 'unstable' | 'behind' | 'draft' | 'unknown'

/** Merge readiness, with the reasons a caller can show the user verbatim. */
export interface GitHubMergeability {
  /** GitHub's own boolean; absent while it is still computing. */
  readonly mergeable?: boolean
  readonly state: GitHubMergeableState
  /** Human-readable blockers; empty when nothing blocks the merge. */
  readonly blockedBy: readonly string[]
}

/**
 * One axis of a structured review. A CLOSED union owned by `dsh-github`:
 * consumers `switch` on it ending in `default: assertNever(...)`, so adding an
 * axis is a deliberate seam change rather than a config string.
 */
export type GitHubReviewDimension =
  | 'correctness'
  | 'tests'
  | 'error-handling'
  | 'types'
  | 'comments'
  | 'simplification'

/** How bad one finding is. Fixed vocabulary so findings stay comparable across reviews. */
export type GitHubReviewSeverityLevel = 'blocker' | 'major' | 'minor' | 'nit'

/** One severity level with the meaning the reviewer is asked to apply. */
export interface GitHubReviewSeverity {
  readonly level: GitHubReviewSeverityLevel
  readonly meaning: string
}

/**
 * One dimension's slice of a review brief. `paths` REFERENCES files of
 * {@link GitHubReviewBrief.diff} rather than copying their patches: the diff is
 * carried exactly once, so N dimensions never multiply the token cost of the
 * same hunk (ADR-0013).
 */
export interface GitHubReviewDimensionBrief {
  readonly dimension: GitHubReviewDimension
  /** Why this dimension applies to THIS pull request — the routing rule that fired. */
  readonly reason: string
  /** Paths within `diff.files` this dimension is about; empty means the whole diff. */
  readonly paths: readonly string[]
  /** What to check, phrased as questions the reviewer answers against the code. */
  readonly checklist: readonly string[]
}

/**
 * Everything a structured review needs, assembled deterministically: the PR,
 * its diff (once), the dimensions that apply, and the contract the findings
 * must satisfy. The seam does NOT judge — it routes and packages evidence, and
 * the model produces findings (ADR-0013).
 */
export interface GitHubReviewBrief {
  readonly pullRequest: GitHubPullRequest
  readonly diff: GitHubDiff
  readonly dimensions: readonly GitHubReviewDimensionBrief[]
  readonly severityScale: readonly GitHubReviewSeverity[]
  /** The shape every finding must take, so reviews stay comparable. */
  readonly outputContract: readonly string[]
  /** True when the diff was reduced — the review is then knowingly partial. */
  readonly truncated: boolean
}

/**
 * Budgets and scope for a review brief. Extends the diff budgets because the
 * brief carries a diff; consumers hold their own numbers here rather than
 * reusing a plain PR read's (ADR-0013: a brief is a different cost profile).
 */
export interface GitHubReviewBriefRequest extends GitHubDiffRequest {
  /** Restrict to these dimensions; omitted = whatever routing selects. */
  readonly dimensions?: readonly GitHubReviewDimension[]
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
  /** Submitted reviews (verdicts) on a pull request. */
  getReviews(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubReview[]>
  /** Aggregated line-anchored review comments on a pull request. */
  getReviewComments(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubReviewComment[]>
  /**
   * Failure evidence for the pull request's failing check runs. The provider
   * decides annotations-versus-logs per ADR-0015 and MAY return an over-budget
   * log; the seam enforces the budget and keeps `truncated` honest.
   */
  getCheckFailures(item: GitHubItemRef, request: GitHubCheckFailureRequest, signal?: AbortSignal): Promise<GitHubCheckFailuresResult>
  /** Merge readiness of a pull request, with the blockers spelled out. */
  getMergeability(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubMergeability>
  /** List pull requests of one repository. */
  listPullRequests(request: GitHubPullRequestListRequest, signal?: AbortSignal): Promise<readonly GitHubPullRequest[]>
  /** Submit one review (verdict + optional summary and inline comments). */
  submitReview(request: GitHubReviewSubmitRequest, signal?: AbortSignal): Promise<GitHubReview>
  /** Update a pull request's own fields. */
  updatePullRequest(request: GitHubPullRequestUpdateRequest, signal?: AbortSignal): Promise<GitHubPullRequest>
  /** Request review from users and/or teams. */
  requestReviewers(request: GitHubReviewersRequest, signal?: AbortSignal): Promise<void>
  /** Apply labels; returns the resulting label set. */
  setLabels(request: GitHubLabelsRequest, signal?: AbortSignal): Promise<readonly string[]>
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
