/**
 * Function plugin registering the `github_*` tool suite over `ctx.github`.
 * Read tools always register; write tools are gated by the `write` switch
 * (default on) and every write asks for user approval through
 * `tools/pre-execute` before anything reaches GitHub. This package owns
 * schemas, prompt guidance, tool-layer budgets, and presentation — never
 * providers or transport.
 *
 * NO default export — the dsh Loader drops `inject` from default-exported
 * function plugins (engineering gate §8).
 * @module dsh-tool-github
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyGitHubSearchTool } from './search.ts'
import { applyGitHubIssueReadTool, applyGitHubPrReadTool } from './read.ts'
import { applyGitHubPrReviewTool } from './review.ts'
import { applyGitHubPrListTool, applyGitHubReviewWriteTools } from './review-write.ts'
import { applyGitHubWriteTools, installWriteApprovalGate } from './write.ts'
import type { ResolvedToolGitHubConfig } from './shared.ts'

export { applyGitHubSearchTool, formatSearchOutput, presentSearchResult, searchCallTitle, searchMetaFromResult } from './search.ts'
export {
  applyGitHubIssueReadTool,
  applyGitHubPrReadTool,
  formatChecks,
  formatCiFailures,
  formatComments,
  formatDiff,
  formatIssue,
  formatReviews,
  formatPullRequestHeader,
  renderPrRead,
  type PullRequestReadPart,
} from './read.ts'
export { applyGitHubPrReviewTool, formatReviewBrief, REVIEW_DIMENSIONS, type ReviewBriefValue } from './review.ts'
export {
  allowedReviewEvents,
  applyGitHubPrListTool,
  applyGitHubReviewWriteTools,
  formatPrList,
  prAssignApprovalReason,
  prUpdateApprovalReason,
  REVIEW_VERDICT_EVENTS,
  reviewSubmitApprovalReason,
} from './review-write.ts'
export { applyGitHubWriteTools, GITHUB_WRITE_TOOLS, installWriteApprovalGate, presentPrCreateResult, prCreateMetaFromResult } from './write.ts'
export { parseRepoInput, preview, repoLabel, runGitHub, toModelError, type ResolvedToolGitHubConfig } from './shared.ts'

/** Cordis plugin name. */
export const name = 'tool-github'
/** Required services; the approval seam stays optional (registry degrades ask→deny). */
export const inject = ['tools', 'github', 'systemPrompt']

/** Plugin config. All optional — the schema supplies defaults. */
export interface Config {
  /** Register the write tools (issue/comment/PR creation). Defaults to true. */
  write?: boolean
  /** Cap on `github_search` hits per call. Defaults to 8. */
  searchMaxResults?: number
  /** Cap on returned conversation comments per read. Defaults to 30. */
  maxComments?: number
  /** Tool-owned diff budget: max changed files per `github_pr_read` diff. Defaults to 50. */
  diffMaxFiles?: number
  /** Tool-owned diff budget: max total patch characters per diff. Defaults to 60000. */
  diffMaxPatchChars?: number
  /** Tool-owned log budget: max trailing log lines per failed check run. Defaults to 80. */
  logMaxLines?: number
  /** Tool-owned log budget: max trailing log characters per failed check run. Defaults to 8000. */
  logMaxChars?: number
  /** Tool-owned review budget: max changed files in a `github_pr_review` brief. Defaults to 60. */
  reviewMaxFiles?: number
  /** Tool-owned review budget: max total patch characters in a brief. Defaults to 120000. */
  reviewMaxPatchChars?: number
  /**
   * Let the model submit APPROVE / REQUEST_CHANGES reviews under the user's own
   * GitHub account. **Defaults to false** (ADR-0014): those two change whether a
   * PR is blocked and read to collaborators as the user's judgement, so the
   * capability is opt-in rather than approval-gated only. Commenting is always
   * available. Ignored entirely when `write` is off.
   */
  reviewVerdicts?: boolean
  /** Cooperative timeout budget (ms) attached to every github tool. Defaults to 30000. */
  timeoutMs?: number
}

/** Config schema (see {@link Config} for field semantics). */
export const Config: z<Config> = z.object({
  write: z.boolean().default(true),
  searchMaxResults: z.number().default(8),
  maxComments: z.number().default(30),
  diffMaxFiles: z.number().default(50),
  diffMaxPatchChars: z.number().default(60000),
  logMaxLines: z.number().default(80),
  logMaxChars: z.number().default(8000),
  reviewMaxFiles: z.number().default(60),
  reviewMaxPatchChars: z.number().default(120000),
  reviewVerdicts: z.boolean().default(false),
  timeoutMs: z.number().default(30000),
})

/** Configured caps and budgets must be positive integers. */
function assertPositiveConfig(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-github: ${name} must be a positive integer`)
}

/**
 * Register the GitHub tool suite: prompt guidance, the three read tools, and —
 * when `write` is on — the three write tools plus their approval gate. All
 * registrations are effects riding this plugin's fiber.
 * @param ctx - plugin context carrying `ctx.tools`, `ctx.github`, `ctx.systemPrompt`.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedToolGitHubConfig
  assertPositiveConfig('searchMaxResults', resolved.searchMaxResults)
  assertPositiveConfig('maxComments', resolved.maxComments)
  assertPositiveConfig('diffMaxFiles', resolved.diffMaxFiles)
  assertPositiveConfig('diffMaxPatchChars', resolved.diffMaxPatchChars)
  assertPositiveConfig('logMaxLines', resolved.logMaxLines)
  assertPositiveConfig('logMaxChars', resolved.logMaxChars)
  assertPositiveConfig('reviewMaxFiles', resolved.reviewMaxFiles)
  assertPositiveConfig('reviewMaxPatchChars', resolved.reviewMaxPatchChars)
  assertPositiveConfig('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({
    name: 'tool:github',
    order: 115,
    text: resolved.write
      ? 'GitHub tools are available. Use github_search to find issues, PRs, repositories, or code; pass the owner/repo and number of a hit to github_issue_read or github_pr_read. PR reads are split into parts (metadata, diff, comments, reviews, ci-failures, checks) — request only what you need. Use part=reviews for line-anchored review feedback to act on, and part=ci-failures to find out WHY a check failed rather than merely that it did. When asked to REVIEW a pull request, call github_pr_review instead of improvising over a raw diff: it returns the dimensions that apply to those particular changes, what to check under each, and the shape your findings must take. Writes (github_issue_create, github_issue_comment, github_pr_create) require the user\'s approval; a denial is an answer, not an error. PR creation is idempotent: an already-open PR for the same branches is returned instead of failing.'
      : 'GitHub read tools are available. Use github_search to find issues, PRs, repositories, or code; pass the owner/repo and number of a hit to github_issue_read or github_pr_read. PR reads are split into parts (metadata, diff, comments, reviews, ci-failures, checks) — request only what you need. Use part=reviews for line-anchored review feedback to act on, and part=ci-failures to find out WHY a check failed rather than merely that it did. When asked to REVIEW a pull request, call github_pr_review instead of improvising over a raw diff: it returns the dimensions that apply to those particular changes, what to check under each, and the shape your findings must take.',
  })

  applyGitHubSearchTool(ctx, resolved)
  applyGitHubIssueReadTool(ctx, resolved)
  applyGitHubPrReadTool(ctx, resolved)
  applyGitHubPrReviewTool(ctx, resolved)
  applyGitHubPrListTool(ctx, resolved)
  if (resolved.write) {
    applyGitHubWriteTools(ctx, resolved)
    applyGitHubReviewWriteTools(ctx, resolved)
    installWriteApprovalGate(ctx)
  }
}
