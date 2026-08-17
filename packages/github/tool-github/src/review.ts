/**
 * The model-facing `github_pr_review` tool: one call that turns "review this
 * PR" from a bare prompt into a task with a known shape — the dimensions that
 * apply, what to check under each, the severity vocabulary, and the contract
 * every finding must satisfy (ADR-0013).
 *
 * This tool orchestrates EVIDENCE, it does not judge. It ships no verdict, no
 * score, and no opinion; the model produces the findings. The review budgets
 * are owned here (tool layer) and enforced at the seam, as with diffs
 * (ADR-0005) — but they are deliberately their own numbers, because a brief is
 * a different cost profile than a plain PR read.
 * @module dsh-tool-github/review
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubReviewDimension } from 'dsh-github'
import { assertPositiveArg, parseRepoInput, repoLabel, runGitHub, type ResolvedToolGitHubConfig } from './shared.ts'
import { formatDiff, formatPullRequestHeader } from './read.ts'

/** The dimension names the tool accepts, mirroring the seam's closed union. */
export const REVIEW_DIMENSIONS: readonly GitHubReviewDimension[] = [
  'correctness', 'tests', 'error-handling', 'types', 'comments', 'simplification',
]

/** Lean JSON projection of one dimension brief. */
interface DimensionValue {
  readonly dimension: string
  readonly reason: string
  readonly paths: readonly string[]
  readonly checklist: readonly string[]
}

/** The value shape `github_pr_review` returns and renders. */
export interface ReviewBriefValue {
  readonly pullRequest: {
    repo: string
    number: number
    title: string
    state: string
    headRef: string
    baseRef: string
    url?: string
    author?: string
    draft?: boolean
    body?: string
  }
  readonly diff: {
    files: { path: string, previousPath?: string, status: string, additions: number, deletions: number, patch?: string }[]
    truncated: boolean
  }
  readonly dimensions: readonly DimensionValue[]
  readonly severityScale: readonly { level: string, meaning: string }[]
  readonly outputContract: readonly string[]
  readonly truncated: boolean
}

/**
 * Render one brief as the review task the model performs.
 *
 * The diff is printed ONCE and dimensions name their files, rather than each
 * dimension repeating the hunks it cares about — six dimensions over one diff
 * must cost one diff.
 * @param value - the brief projection.
 * @returns the markdown review task.
 */
export function formatReviewBrief(value: ReviewBriefValue): string {
  const sections: string[] = [
    `## Review task: ${value.pullRequest.repo}#${value.pullRequest.number}`,
    formatPullRequestHeader(value.pullRequest),
    '## Changed files',
    formatDiff(value.diff),
  ]
  if (value.dimensions.length === 0) {
    sections.push('## Dimensions\n\nNothing routable changed (no source, tests, or documentation). There is nothing to review here — say so instead of inventing findings.')
  } else {
    sections.push(`## Dimensions (${value.dimensions.length} apply)`)
    sections.push(value.dimensions.map(formatDimension).join('\n\n'))
  }
  sections.push(`## Severity\n${value.severityScale.map(entry => `- **${entry.level}** — ${entry.meaning}`).join('\n')}`)
  sections.push(`## Report every finding like this\n${value.outputContract.map(rule => `- ${rule}`).join('\n')}`)
  if (value.truncated) {
    sections.push('The diff above was truncated by budget, so this review is knowingly partial — say which parts you could not see rather than implying full coverage.')
  }
  return sections.join('\n\n')
}

/** One dimension as a heading, the rule that selected it, its files, and its checklist. */
function formatDimension(dimension: DimensionValue): string {
  const files = dimension.paths.length === 0 ? 'the whole diff' : dimension.paths.join(', ')
  return [
    `### ${dimension.dimension}`,
    `Applies because: ${dimension.reason}. Files: ${files}`,
    dimension.checklist.map(question => `- ${question}`).join('\n'),
  ].join('\n')
}

/**
 * Register `github_pr_review`: a READ tool (it writes nothing to GitHub and so
 * is not gated by the `write` switch) that returns the structured review task
 * for one pull request.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (review budgets, timeout).
 */
export function applyGitHubPrReviewTool(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_pr_review',
    description: 'Assemble the structured review task for one GitHub pull request: its diff, the review dimensions that apply to these particular changes, the checklist under each, the severity scale, and the shape every finding must take. Returns evidence and a contract — the findings are yours to produce. Use this instead of reading a diff and improvising when asked to review a PR.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Pull request number.' },
      dimensions: {
        type: 'array',
        items: { type: 'string', enum: [...REVIEW_DIMENSIONS] },
        description: 'Restrict the review to these dimensions. Omit to let the change itself decide which apply.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pullRequest: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              repo: { type: 'string', required: true },
              number: { type: 'integer', required: true },
              title: { type: 'string', required: true },
              state: { type: 'string', required: true },
              headRef: { type: 'string', required: true },
              baseRef: { type: 'string', required: true },
              url: { type: 'string' },
              author: { type: 'string' },
              draft: { type: 'boolean' },
              body: { type: 'string' },
            },
          },
          diff: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              files: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    previousPath: { type: 'string' },
                    status: { type: 'string', required: true },
                    additions: { type: 'integer', required: true },
                    deletions: { type: 'integer', required: true },
                    patch: { type: 'string' },
                  },
                },
              },
              truncated: { type: 'boolean', required: true },
            },
          },
          dimensions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dimension: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                paths: { type: 'array', required: true, items: { type: 'string' } },
                checklist: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          severityScale: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                meaning: { type: 'string', required: true },
              },
            },
          },
          outputContract: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReviewBrief(value) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertPositiveArg('number', args.number)
      const item = { repo: parseRepoInput(args.repo), number: args.number }
      const brief = await runGitHub(() => ctx.github.buildReviewBrief(item, {
        maxFiles: config.reviewMaxFiles,
        maxPatchChars: config.reviewMaxPatchChars,
        ...args.dimensions === undefined ? {} : { dimensions: args.dimensions as GitHubReviewDimension[] },
      }, exec.signal))
      return {
        pullRequest: {
          repo: repoLabel(item.repo),
          number: brief.pullRequest.ref.number,
          title: brief.pullRequest.title,
          state: brief.pullRequest.state,
          headRef: brief.pullRequest.headRef,
          baseRef: brief.pullRequest.baseRef,
          ...brief.pullRequest.ref.url === undefined ? {} : { url: brief.pullRequest.ref.url },
          ...brief.pullRequest.author === undefined ? {} : { author: brief.pullRequest.author },
          ...brief.pullRequest.draft === undefined ? {} : { draft: brief.pullRequest.draft },
          ...brief.pullRequest.body === undefined ? {} : { body: brief.pullRequest.body },
        },
        diff: {
          files: brief.diff.files.map(file => ({
            path: file.path,
            ...file.previousPath === undefined ? {} : { previousPath: file.previousPath },
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...file.patch === undefined ? {} : { patch: file.patch },
          })),
          truncated: brief.diff.truncated,
        },
        dimensions: brief.dimensions.map(dimension => ({
          dimension: dimension.dimension,
          reason: dimension.reason,
          paths: [...dimension.paths],
          checklist: [...dimension.checklist],
        })),
        severityScale: brief.severityScale.map(entry => ({ level: entry.level, meaning: entry.meaning })),
        outputContract: [...brief.outputContract],
        truncated: brief.truncated,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Assemble review of GitHub PR ${args.repo}#${args.number}`,
      kind: 'read',
      rawInput: `${args.repo}#${args.number}`,
    }),
  }))
}
