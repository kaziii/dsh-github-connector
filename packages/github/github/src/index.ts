/**
 * Service Definition for the GitHub capability seam (`ctx.github`): provider registry and
 * provider-selecting execution for every GitHub operation. Duplicate ids are rejected. At
 * execution time, a configured provider must exist and be usable; without one, exactly one
 * usable provider is required, so selection never depends on registration order. Providers
 * are resolved on EVERY operation and never cached, so credential/config changes take effect
 * without restart.
 * @module dsh-github
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  GitHubCheckFailure,
  GitHubCheckFailureRequest,
  GitHubCheckFailuresResult,
  GitHubCheckLog,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentCreateRequest,
  GitHubDiff,
  GitHubDiffFile,
  GitHubDiffRequest,
  GitHubIssue,
  GitHubIssueCreateRequest,
  GitHubItemRef,
  GitHubLabelsRequest,
  GitHubMergeability,
  GitHubProvider,
  GitHubPullRequest,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestCreateResult,
  GitHubPullRequestListRequest,
  GitHubPullRequestUpdateRequest,
  GitHubRepoRef,
  GitHubReviewersRequest,
  GitHubReviewSubmitRequest,
  GitHubReview,
  GitHubReviewBrief,
  GitHubReviewBriefRequest,
  GitHubReviewComment,
  GitHubSearchRequest,
  GitHubSearchResult,
} from './types.ts'
import { GitHubError } from './types.ts'
import { buildReviewBrief } from './review.ts'

export {
  GitHubError,
} from './types.ts'
export { buildReviewBrief, changedLines, classifyFile, routeDimensions, type GitHubFileKind } from './review.ts'
export type {
  GitHubAnnotationLevel,
  GitHubCheckAnnotation,
  GitHubCheckConclusion,
  GitHubCheckFailure,
  GitHubCheckFailureRequest,
  GitHubCheckFailuresResult,
  GitHubCheckLog,
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubCheckStatus,
  GitHubComment,
  GitHubCommentCreateRequest,
  GitHubDiff,
  GitHubDiffFile,
  GitHubDiffFileStatus,
  GitHubDiffRequest,
  GitHubErrorOptions,
  GitHubIssue,
  GitHubIssueCreateRequest,
  GitHubIssueState,
  GitHubItemRef,
  GitHubLabelsRequest,
  GitHubMergeability,
  GitHubMergeableState,
  GitHubProvider,
  GitHubPullRequest,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestCreateResult,
  GitHubPullRequestListRequest,
  GitHubPullRequestState,
  GitHubPullRequestUpdateRequest,
  GitHubRepoRef,
  GitHubReview,
  GitHubReviewBrief,
  GitHubReviewBriefRequest,
  GitHubReviewComment,
  GitHubReviewCommentDraft,
  GitHubReviewDimension,
  GitHubReviewDimensionBrief,
  GitHubReviewersRequest,
  GitHubReviewEvent,
  GitHubReviewSeverity,
  GitHubReviewSeverityLevel,
  GitHubReviewSide,
  GitHubReviewState,
  GitHubReviewSubmitRequest,
  GitHubSearchItem,
  GitHubSearchKind,
  GitHubSearchRequest,
  GitHubSearchResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    github: GitHubRuntime
  }
}

/**
 * Config for the GitHub seam. `provider` pins which provider wins; optional (a
 * single registered usable provider auto-selects). Operational overrides such
 * as environment variables must feed this same field rather than introduce a
 * hidden priority chain.
 */
export interface GitHubRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The GitHub service. Registered as `ctx.github` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `GITHUB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `GITHUB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `GITHUB_PROVIDER_UNAVAILABLE`.
 */
export class GitHubRuntime extends Service {
  /**
   * Provider selection config. The operational env override feeds the SAME
   * field: `$DSH_GITHUB_PROVIDER` is equivalent to `provider` and is NOT a
   * hidden priority chain.
   */
  static Config: z<GitHubRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, GitHubProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: GitHubRuntimeConfig = {}) {
    super(ctx, 'github')
    this.providerId = config.provider ?? process.env.DSH_GITHUB_PROVIDER
  }

  /**
   * Register a GitHub provider. Throws {@link GitHubError}
   * `GITHUB_PROVIDER_DUPLICATE` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: GitHubProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new GitHubError(`a GitHub provider with id "${provider.id}" is already registered`, 'GITHUB_PROVIDER_DUPLICATE')
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'github.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. The seam enforces
   * `request.maxResults` on the result: if the provider over-returns,
   * `items[]` is truncated and `truncated` set.
   * @param request - the search kind, query, and optional result bound.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's hits, capped to `request.maxResults`.
   */
  async search(request: GitHubSearchRequest, signal?: AbortSignal): Promise<GitHubSearchResult> {
    assertPositiveInteger('maxResults', request.maxResults)
    const result = await this.resolveProvider().search(request, signal)
    return capItems(result, request.maxResults)
  }

  /**
   * Read one issue through the selected provider.
   * @param item - the issue handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized issue.
   */
  async getIssue(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubIssue> {
    assertItemRef(item)
    return this.resolveProvider().getIssue(item, signal)
  }

  /**
   * Read one pull request's metadata through the selected provider. Diff and
   * checks are separate on-demand operations.
   * @param item - the pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized pull request.
   */
  async getPullRequest(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubPullRequest> {
    assertItemRef(item)
    return this.resolveProvider().getPullRequest(item, signal)
  }

  /**
   * Read the aggregated conversation comments of an issue or pull request.
   * @param item - the issue or pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized comments.
   */
  async getComments(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubComment[]> {
    assertItemRef(item)
    return this.resolveProvider().getComments(item, signal)
  }

  /**
   * Read one pull request's diff through the selected provider, enforcing the
   * request's budgets at the seam (ADR-0005). The provider may return the diff
   * full or pre-truncated; the final result never exceeds the budgets and
   * `truncated` is true whenever ANY reduction happened.
   * @param item - the pull request handle.
   * @param request - consumer-owned `maxFiles` / `maxPatchChars` budgets.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the budgeted diff.
   */
  async getDiff(item: GitHubItemRef, request: GitHubDiffRequest = {}, signal?: AbortSignal): Promise<GitHubDiff> {
    assertItemRef(item)
    assertPositiveInteger('maxFiles', request.maxFiles)
    assertPositiveInteger('maxPatchChars', request.maxPatchChars)
    const diff = await this.resolveProvider().getDiff(item, request, signal)
    return applyDiffBudget(diff, request)
  }

  /**
   * Assemble a structured review brief: the pull request, its budgeted diff,
   * the dimensions that DETERMINISTICALLY apply to it, and the checklists,
   * severity scale, and output contract a review must satisfy (ADR-0013).
   *
   * The seam routes and packages evidence; it never judges. The diff is carried
   * once and dimensions reference its paths, so N dimensions cost one diff.
   * @param item - the pull request handle.
   * @param request - consumer-owned diff budgets plus an optional dimension restriction.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the brief, `truncated` when its diff was reduced.
   */
  async buildReviewBrief(
    item: GitHubItemRef,
    request: GitHubReviewBriefRequest = {},
    signal?: AbortSignal,
  ): Promise<GitHubReviewBrief> {
    assertItemRef(item)
    const provider = this.resolveProvider()
    const pullRequest = await provider.getPullRequest(item, signal)
    const diff = await this.getDiff(item, request, signal)
    return buildReviewBrief(pullRequest, diff, request)
  }

  /**
   * Read the check runs of a pull request's head commit.
   * @param item - the pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized check runs.
   */
  async getChecks(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubChecksResult> {
    assertItemRef(item)
    return this.resolveProvider().getChecks(item, signal)
  }

  /**
   * Read the submitted reviews (verdicts) of a pull request.
   * @param item - the pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized reviews.
   */
  async getReviews(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubReview[]> {
    assertItemRef(item)
    return this.resolveProvider().getReviews(item, signal)
  }

  /**
   * Read the line-anchored review comments of a pull request. These are NOT the
   * issue-level conversation comments {@link getComments} returns.
   * @param item - the pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the normalized review comments.
   */
  async getReviewComments(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubReviewComment[]> {
    assertItemRef(item)
    return this.resolveProvider().getReviewComments(item, signal)
  }

  /**
   * Read failure evidence for a pull request's failing check runs, enforcing
   * the request's log budgets at the seam (ADR-0005 mechanism, ADR-0015
   * policy). The provider may return logs full or pre-truncated; the final
   * result never exceeds the budgets and `truncated` is true whenever ANY
   * reduction happened.
   * @param item - the pull request handle.
   * @param request - consumer-owned `maxLogLines` / `maxLogChars` budgets and log mode.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the budgeted failure evidence.
   */
  async getCheckFailures(
    item: GitHubItemRef,
    request: GitHubCheckFailureRequest = {},
    signal?: AbortSignal,
  ): Promise<GitHubCheckFailuresResult> {
    assertItemRef(item)
    assertPositiveInteger('maxLogLines', request.maxLogLines)
    assertPositiveInteger('maxLogChars', request.maxLogChars)
    const result = await this.resolveProvider().getCheckFailures(item, request, signal)
    return applyLogBudget(result, request)
  }

  /**
   * Read a pull request's merge readiness. Callers are expected to consult this
   * BEFORE attempting a merge, so a doomed merge is refused locally with a
   * reason rather than as an opaque HTTP failure.
   * @param item - the pull request handle.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns mergeability with human-readable blockers.
   */
  async getMergeability(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubMergeability> {
    assertItemRef(item)
    return this.resolveProvider().getMergeability(item, signal)
  }

  /**
   * List a repository's pull requests, capped at the seam like {@link search}.
   * @param request - repo, filters, and an optional result bound.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the pull requests, capped to `request.maxResults`.
   */
  async listPullRequests(request: GitHubPullRequestListRequest, signal?: AbortSignal): Promise<readonly GitHubPullRequest[]> {
    assertRepoRef(request.repo)
    assertPositiveInteger('maxResults', request.maxResults)
    const items = await this.resolveProvider().listPullRequests(request, signal)
    return request.maxResults === undefined ? items : items.slice(0, request.maxResults)
  }

  /**
   * Submit one review. The seam does NOT decide whether a verdict is allowed —
   * that gate lives at the tool layer (ADR-0014), because it is a policy about
   * what the MODEL may do, not about what GitHub supports.
   * @param request - target PR, event, and optional body and inline comments.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the submitted review.
   */
  async submitReview(request: GitHubReviewSubmitRequest, signal?: AbortSignal): Promise<GitHubReview> {
    assertItemRef(request.item)
    assertReviewComments(request.comments)
    return this.resolveProvider().submitReview(request, signal)
  }

  /**
   * Update one pull request's own fields.
   * @param request - target PR plus the fields to change.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the updated pull request.
   */
  async updatePullRequest(request: GitHubPullRequestUpdateRequest, signal?: AbortSignal): Promise<GitHubPullRequest> {
    assertItemRef(request.item)
    return this.resolveProvider().updatePullRequest(request, signal)
  }

  /**
   * Request review from users and/or teams.
   * @param request - target PR plus reviewers.
   * @param signal - optional cancellation signal forwarded to the provider.
   */
  async requestReviewers(request: GitHubReviewersRequest, signal?: AbortSignal): Promise<void> {
    assertItemRef(request.item)
    return this.resolveProvider().requestReviewers(request, signal)
  }

  /**
   * Apply labels to an issue or pull request.
   * @param request - target item, labels, and add-vs-set mode.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the resulting label set.
   */
  async setLabels(request: GitHubLabelsRequest, signal?: AbortSignal): Promise<readonly string[]> {
    assertItemRef(request.item)
    return this.resolveProvider().setLabels(request, signal)
  }

  /**
   * Create one issue through the selected provider.
   * @param request - target repo plus issue content.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the created issue.
   */
  async createIssue(request: GitHubIssueCreateRequest, signal?: AbortSignal): Promise<GitHubIssue> {
    assertRepoRef(request.repo)
    return this.resolveProvider().createIssue(request, signal)
  }

  /**
   * Create one conversation comment through the selected provider.
   * @param request - target issue/PR handle plus comment body.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the created comment.
   */
  async createComment(request: GitHubCommentCreateRequest, signal?: AbortSignal): Promise<GitHubComment> {
    assertItemRef(request.item)
    return this.resolveProvider().createComment(request, signal)
  }

  /**
   * Create one pull request through the selected provider. Idempotent
   * (ADR-0004): when an open PR for the same head/base already exists, the
   * provider returns it with `created: false` instead of failing.
   * @param request - target repo, branches, and PR content.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the created or pre-existing pull request with the `created` flag.
   */
  async createPullRequest(request: GitHubPullRequestCreateRequest, signal?: AbortSignal): Promise<GitHubPullRequestCreateResult> {
    assertRepoRef(request.repo)
    return this.resolveProvider().createPullRequest(request, signal)
  }

  /** Resolve the selected provider AT CALL TIME or throw the matching {@link GitHubError}. */
  private resolveProvider(): GitHubProvider {
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (!provider) {
        throw new GitHubError(`configured GitHub provider "${this.providerId}" is not registered`, 'GITHUB_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new GitHubError(`configured GitHub provider "${this.providerId}" is registered but unavailable`, 'GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new GitHubError('no usable GitHub provider is registered', 'GITHUB_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new GitHubError(`multiple usable GitHub providers are registered (${ids}); configure one explicitly`, 'GITHUB_PROVIDER_AMBIGUOUS')
    }
    return single
  }
}

/** Reject a blank-owner or blank-repo ref with `GITHUB_VALIDATION`. */
function assertRepoRef(ref: GitHubRepoRef): void {
  if (ref.owner.trim() === '' || ref.repo.trim() === '') {
    throw new GitHubError('a GitHub repo ref requires a non-blank owner and repo', 'GITHUB_VALIDATION')
  }
}

/** Reject an invalid repo ref or non-positive-integer item number with `GITHUB_VALIDATION`. */
function assertItemRef(item: GitHubItemRef): void {
  assertRepoRef(item.repo)
  if (!Number.isInteger(item.number) || item.number <= 0) {
    throw new GitHubError(`a GitHub item number must be a positive integer, got ${item.number}`, 'GITHUB_VALIDATION')
  }
}

/**
 * Reject inline review comments that could not anchor. A comment without a
 * real line number would be rejected by GitHub anyway, and reporting it here
 * names the offending path instead of surfacing an opaque 422.
 */
function assertReviewComments(comments: GitHubReviewSubmitRequest['comments']): void {
  for (const comment of comments ?? []) {
    if (comment.path.trim() === '') {
      throw new GitHubError('a review comment requires a non-blank path', 'GITHUB_VALIDATION')
    }
    if (!Number.isInteger(comment.line) || comment.line <= 0) {
      throw new GitHubError(`a review comment on ${comment.path} needs a positive integer line, got ${comment.line}`, 'GITHUB_VALIDATION')
    }
  }
}

/** Reject a present-but-not-positive-integer budget parameter with `GITHUB_VALIDATION`. */
function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value <= 0) {
    throw new GitHubError(`${name} must be a positive integer, got ${value}`, 'GITHUB_VALIDATION')
  }
}

/** Enforce `maxResults` on a search result: truncate `items[]` and flag it. */
function capItems(result: GitHubSearchResult, maxResults: number | undefined): GitHubSearchResult {
  if (maxResults === undefined || result.items.length <= maxResults) return result
  return { ...result, items: result.items.slice(0, maxResults), truncated: true }
}

/**
 * Enforce diff budgets at the seam (ADR-0005). `maxFiles` drops whole trailing
 * files; `maxPatchChars` bounds TOTAL patch characters — the overflowing patch
 * is cut at the remaining budget and later patches are dropped (file metadata
 * stays). `truncated` is true whenever any reduction happened here or at the
 * provider.
 */
function applyDiffBudget(diff: GitHubDiff, request: GitHubDiffRequest): GitHubDiff {
  let truncated = diff.truncated
  let files = diff.files
  if (request.maxFiles !== undefined && files.length > request.maxFiles) {
    files = files.slice(0, request.maxFiles)
    truncated = true
  }
  if (request.maxPatchChars !== undefined) {
    let remaining = request.maxPatchChars
    let cut = false
    const budgeted: GitHubDiffFile[] = []
    for (const file of files) {
      if (file.patch === undefined) {
        budgeted.push(file)
        continue
      }
      if (file.patch.length <= remaining) {
        remaining -= file.patch.length
        budgeted.push(file)
        continue
      }
      cut = true
      if (remaining > 0) {
        budgeted.push({ ...file, patch: file.patch.slice(0, remaining) })
        remaining = 0
      } else {
        const { patch: _dropped, ...metadata } = file
        budgeted.push(metadata)
      }
    }
    if (cut) {
      files = budgeted
      truncated = true
    }
  }
  if (files === diff.files && truncated === diff.truncated) return diff
  return { files, truncated }
}

/**
 * Enforce log budgets at the seam and propagate honesty upward: a failure whose
 * log the PROVIDER already truncated marks the whole result truncated even when
 * no budget applies here, so `truncated` never under-reports.
 */
function applyLogBudget(result: GitHubCheckFailuresResult, request: GitHubCheckFailureRequest): GitHubCheckFailuresResult {
  let truncated = result.truncated
  let changed = false
  const failures: GitHubCheckFailure[] = result.failures.map(failure => {
    if (failure.log === undefined) return failure
    const log = budgetLogTail(failure.log, request)
    if (log.truncated) truncated = true
    if (log === failure.log) return failure
    changed = true
    return { ...failure, log }
  })
  if (!changed && truncated === result.truncated) return result
  return { failures, truncated }
}

/**
 * Cut one log down to its TAIL under the budgets (ADR-0015). Lines go first,
 * then characters; the character cut is realigned forward to a line start so
 * the tail never opens mid-line. When the whole character budget lands inside a
 * single line, realignment would leave nothing — the partial line is kept
 * instead, because a truncated line still names the failure and an empty log
 * names nothing.
 */
function budgetLogTail(log: GitHubCheckLog, request: GitHubCheckFailureRequest): GitHubCheckLog {
  let text = log.text
  let cut = false
  if (request.maxLogLines !== undefined) {
    const lines = text.split('\n')
    if (lines.length > request.maxLogLines) {
      text = lines.slice(-request.maxLogLines).join('\n')
      cut = true
    }
  }
  if (request.maxLogChars !== undefined && text.length > request.maxLogChars) {
    const tail = text.slice(text.length - request.maxLogChars)
    const newline = tail.indexOf('\n')
    const aligned = newline === -1 ? '' : tail.slice(newline + 1)
    text = aligned === '' ? tail : aligned
    cut = true
  }
  if (!cut) return log
  return { text, truncated: true }
}

export default GitHubRuntime
