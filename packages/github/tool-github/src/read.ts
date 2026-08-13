/**
 * The model-facing `github_issue_read` and `github_pr_read` tools. PR reads
 * split into on-demand parts (`metadata` / `diff` / `comments` / `checks`) so
 * one call never pays for data the model did not ask for; the diff budgets are
 * OWNED HERE (tool layer) and passed to the seam, which enforces them
 * (ADR-0005).
 * @module dsh-tool-github/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubComment, GitHubDiff, GitHubIssue, GitHubItemRef, GitHubPullRequest } from 'dsh-github'
import { assertPositiveArg, parseRepoInput, repoLabel, runGitHub, type ResolvedToolGitHubConfig } from './shared.ts'

/** The PR read parts — a CLOSED union consumers switch over. */
export type PullRequestReadPart = 'metadata' | 'diff' | 'comments' | 'checks'

/** Lean JSON projection of one comment. */
interface CommentValue {
  readonly body: string
  readonly author?: string
  readonly createdAt?: string
}

function projectComment(comment: GitHubComment): CommentValue {
  return {
    body: comment.body,
    ...comment.author === undefined ? {} : { author: comment.author },
    ...comment.createdAt === undefined ? {} : { createdAt: comment.createdAt },
  }
}

/** One comment as a markdown list line. */
function commentLine(comment: CommentValue): string {
  const meta = [comment.author ?? 'unknown', ...comment.createdAt === undefined ? [] : [comment.createdAt]]
  return `- ${meta.join(', ')}: ${comment.body}`
}

/** The comments section shared by issue and PR reads. */
export function formatComments(comments: readonly CommentValue[], total: number): string {
  if (total === 0) return 'No comments.'
  const header = comments.length < total
    ? `Comments (showing ${comments.length} of ${total}; raise max_comments for more):`
    : `Comments (${total}):`
  return `${header}\n${comments.map(commentLine).join('\n')}`
}

/** Comment slice + count under the tool-owned cap. */
function capComments(all: readonly GitHubComment[], requested: number | undefined, cap: number): { comments: CommentValue[], total: number } {
  const bound = Math.min(requested ?? cap, cap)
  return { comments: all.slice(0, bound).map(projectComment), total: all.length }
}

/** Issue header + body formatting. */
export function formatIssue(value: { repo: string, number: number, title: string, state: string, author?: string, labels?: readonly string[], body?: string }): string {
  const facts = [`State: ${value.state}`]
  if (value.author !== undefined) facts.push(`Author: ${value.author}`)
  if (value.labels !== undefined && value.labels.length > 0) facts.push(`Labels: ${value.labels.join(', ')}`)
  const body = value.body === undefined || value.body.trim() === '' ? '(no description)' : value.body
  return `### ${value.repo}#${value.number}: ${value.title}\n${facts.join(' · ')}\n\n${body}`
}

/** PR header + body formatting (adds branches, draft, merged state). */
export function formatPullRequestHeader(value: { repo: string, number: number, title: string, state: string, headRef: string, baseRef: string, author?: string, draft?: boolean, body?: string }): string {
  const facts = [`State: ${value.state}${value.draft === true ? ' (draft)' : ''}`, `Branches: ${value.headRef} → ${value.baseRef}`]
  if (value.author !== undefined) facts.push(`Author: ${value.author}`)
  const body = value.body === undefined || value.body.trim() === '' ? '(no description)' : value.body
  return `### ${value.repo}#${value.number}: ${value.title}\n${facts.join(' · ')}\n\n${body}`
}

/** Diff formatting: per-file header lines plus fenced patches when present. */
export function formatDiff(diff: { files: readonly { path: string, previousPath?: string, status: string, additions: number, deletions: number, patch?: string }[], truncated: boolean }): string {
  if (diff.files.length === 0) return 'No changed files.'
  const sections = diff.files.map(file => {
    const rename = file.previousPath === undefined ? '' : ` (from ${file.previousPath})`
    const header = `--- ${file.path}${rename} · ${file.status} · +${file.additions}/-${file.deletions}`
    return file.patch === undefined ? header : `${header}\n\`\`\`diff\n${file.patch}\n\`\`\``
  })
  const parts = [sections.join('\n')]
  if (diff.truncated) parts.push('(Diff truncated by budget. Ask for specific files or a narrower part.)')
  return parts.join('\n\n')
}

/** Check-run list with an overall verdict line. */
export function formatChecks(runs: readonly { name: string, status: string, conclusion?: string, url?: string }[]): string {
  if (runs.length === 0) return 'No check runs reported.'
  const lines = runs.map(run => `- ${run.name}: ${run.conclusion ?? run.status}`)
  const failing = runs.filter(run => run.conclusion !== undefined && run.conclusion !== 'success' && run.conclusion !== 'neutral' && run.conclusion !== 'skipped')
  const pending = runs.filter(run => run.conclusion === undefined)
  const verdict = failing.length > 0
    ? `${failing.length} failing`
    : pending.length > 0
      ? `${pending.length} still running`
      : 'all passing'
  return `Checks (${verdict}):\n${lines.join('\n')}`
}

/** Project the seam issue into the output value. */
function projectIssue(repo: string, issue: GitHubIssue): { repo: string, number: number, title: string, state: string, url?: string, author?: string, labels?: string[], body?: string } {
  return {
    repo,
    number: issue.ref.number,
    title: issue.title,
    state: issue.state,
    ...issue.ref.url === undefined ? {} : { url: issue.ref.url },
    ...issue.author === undefined ? {} : { author: issue.author },
    ...issue.labels === undefined ? {} : { labels: [...issue.labels] },
    ...issue.body === undefined ? {} : { body: issue.body },
  }
}

/** Project the seam PR into the output value. */
function projectPullRequest(repo: string, pr: GitHubPullRequest): { repo: string, number: number, title: string, state: string, headRef: string, baseRef: string, url?: string, author?: string, draft?: boolean, body?: string } {
  return {
    repo,
    number: pr.ref.number,
    title: pr.title,
    state: pr.state,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    ...pr.ref.url === undefined ? {} : { url: pr.ref.url },
    ...pr.author === undefined ? {} : { author: pr.author },
    ...pr.draft === undefined ? {} : { draft: pr.draft },
    ...pr.body === undefined ? {} : { body: pr.body },
  }
}

/** Shared item-ref assembly from the two read-tool arguments. */
function itemFromArgs(repo: string, number: number): GitHubItemRef {
  assertPositiveArg('number', number)
  return { repo: parseRepoInput(repo), number }
}

/** Comment output schema node shared by both read tools. */
const COMMENTS_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      body: { type: 'string', required: true },
      author: { type: 'string' },
      createdAt: { type: 'string' },
    },
  },
} as const

/**
 * Register `github_issue_read`: body plus capped aggregated comments.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (`maxComments` cap, timeout).
 */
export function applyGitHubIssueReadTool(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_issue_read',
    description: 'Read one GitHub issue: title, state, labels, body, and its conversation comments.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Issue number.' },
      max_comments: { type: 'integer', description: 'Upper bound on returned comments (subject to the deployment cap).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issue: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              repo: { type: 'string', required: true },
              number: { type: 'integer', required: true },
              title: { type: 'string', required: true },
              state: { type: 'string', required: true },
              url: { type: 'string' },
              author: { type: 'string' },
              labels: { type: 'array', items: { type: 'string' } },
              body: { type: 'string' },
            },
          },
          comments: COMMENTS_SCHEMA,
          totalComments: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${formatIssue(value.issue)}\n\n${formatComments(value.comments, value.totalComments)}`,
      }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.max_comments !== undefined) assertPositiveArg('max_comments', args.max_comments)
      const item = itemFromArgs(args.repo, args.number)
      const issue = await runGitHub(() => ctx.github.getIssue(item, exec.signal))
      const all = await runGitHub(() => ctx.github.getComments(item, exec.signal))
      const { comments, total } = capComments(all, args.max_comments, config.maxComments)
      return { issue: projectIssue(repoLabel(item.repo), issue), comments, totalComments: total }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read GitHub issue ${args.repo}#${args.number}`,
      kind: 'read',
      rawInput: `${args.repo}#${args.number}`,
    }),
  }))
}

/**
 * Register `github_pr_read`: metadata by default; `diff`, `comments`, and
 * `checks` are separate on-demand parts.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (diff budgets, comment cap, timeout).
 */
export function applyGitHubPrReadTool(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_pr_read',
    description: 'Read one GitHub pull request. part=metadata (default) returns title/state/branches/body; part=diff returns the changed files with patches (budgeted); part=comments returns the conversation; part=checks returns CI check runs.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Pull request number.' },
      part: {
        type: 'string',
        enum: ['metadata', 'diff', 'comments', 'checks'],
        description: 'Which facet to read; defaults to metadata.',
      },
      max_comments: { type: 'integer', description: 'Upper bound on returned comments (part=comments only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          part: { type: 'string', required: true },
          pullRequest: {
            type: 'object',
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
          comments: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: COMMENTS_SCHEMA,
              total: { type: 'integer', required: true },
            },
          },
          checks: {
            type: 'object',
            additionalProperties: false,
            properties: {
              runs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    conclusion: { type: 'string' },
                    url: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPrRead(value) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.max_comments !== undefined) assertPositiveArg('max_comments', args.max_comments)
      const item = itemFromArgs(args.repo, args.number)
      const label = repoLabel(item.repo)
      const part: PullRequestReadPart = args.part ?? 'metadata'
      switch (part) {
        case 'metadata': {
          const pr = await runGitHub(() => ctx.github.getPullRequest(item, exec.signal))
          return { part, pullRequest: projectPullRequest(label, pr) }
        }
        case 'diff': {
          const diff: GitHubDiff = await runGitHub(() =>
            ctx.github.getDiff(item, { maxFiles: config.diffMaxFiles, maxPatchChars: config.diffMaxPatchChars }, exec.signal))
          return {
            part,
            diff: {
              files: diff.files.map(file => ({
                path: file.path,
                ...file.previousPath === undefined ? {} : { previousPath: file.previousPath },
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                ...file.patch === undefined ? {} : { patch: file.patch },
              })),
              truncated: diff.truncated,
            },
          }
        }
        case 'comments': {
          const all = await runGitHub(() => ctx.github.getComments(item, exec.signal))
          const { comments, total } = capComments(all, args.max_comments, config.maxComments)
          return { part, comments: { items: comments, total } }
        }
        case 'checks': {
          const checks = await runGitHub(() => ctx.github.getChecks(item, exec.signal))
          return {
            part,
            checks: {
              runs: checks.runs.map(run => ({
                name: run.name,
                status: run.status,
                ...run.conclusion === undefined ? {} : { conclusion: run.conclusion },
                ...run.url === undefined ? {} : { url: run.url },
              })),
            },
          }
        }
        /* v8 ignore next 2 -- the schema's closed enum already rejects other parts; assertNever guards vocabulary drift at compile time */
        default:
          return assertNever(part, 'PullRequestReadPart')
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read GitHub PR ${args.repo}#${args.number} (${args.part ?? 'metadata'})`,
      kind: 'read',
      rawInput: `${args.repo}#${args.number}`,
    }),
  }))
}

/** Render one `github_pr_read` value by its part. */
export function renderPrRead(value: {
  part: string
  pullRequest?: { repo: string, number: number, title: string, state: string, headRef: string, baseRef: string, author?: string, draft?: boolean, body?: string }
  diff?: { files: { path: string, previousPath?: string, status: string, additions: number, deletions: number, patch?: string }[], truncated: boolean }
  comments?: { items: { body: string, author?: string, createdAt?: string }[], total: number }
  checks?: { runs: { name: string, status: string, conclusion?: string, url?: string }[] }
}): string {
  if (value.pullRequest !== undefined) return formatPullRequestHeader(value.pullRequest)
  if (value.diff !== undefined) return formatDiff(value.diff)
  if (value.comments !== undefined) return formatComments(value.comments.items, value.comments.total)
  if (value.checks !== undefined) return formatChecks(value.checks.runs)
  return `No data for part "${value.part}".`
}
