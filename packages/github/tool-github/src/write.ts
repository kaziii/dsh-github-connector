/**
 * The approval-gated write tools: `github_issue_create`, `github_issue_comment`,
 * and `github_pr_create`. Every write asks through `tools/pre-execute` with a
 * human-readable reason (target repo, title, body preview); a denial becomes a
 * model-visible refusal result, never an exception. `github_pr_create` presents
 * the seam's idempotent outcome (ADR-0004): an already-open PR is a normal
 * answer, not an error.
 * @module dsh-tool-github/write
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { parseRepoInput, preview, repoLabel, runGitHub, type ResolvedToolGitHubConfig } from './shared.ts'

/** The gated tool names, exported so tests and hosts can recognize the set. */
export const GITHUB_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'github_issue_create',
  'github_issue_comment',
  'github_pr_create',
])

/** Read one string argument defensively (pre-validation raw args). */
function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Read one number argument defensively (pre-validation raw args). */
function argNumber(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

/** Approval reasons per write tool: target repo, title, and body preview. */
const APPROVAL_REASONS: Record<string, (args: unknown) => string> = {
  github_issue_create: args => {
    const body = preview(argString(args, 'body'))
    return `Create GitHub issue in ${argString(args, 'repo') ?? '?'}: "${argString(args, 'title') ?? '?'}"${body === '' ? '' : ` — ${body}`}`
  },
  github_issue_comment: args =>
    `Comment on GitHub ${argString(args, 'repo') ?? '?'}#${argNumber(args, 'number') ?? '?'}: ${preview(argString(args, 'body'))}`,
  github_pr_create: args =>
    `Create GitHub pull request in ${argString(args, 'repo') ?? '?'} (${argString(args, 'head') ?? '?'} → ${argString(args, 'base') ?? '?'}): "${argString(args, 'title') ?? '?'}"`,
}

/**
 * Gate every write tool behind the approval waterfall. The registry resolves
 * `ask` through the optional approval seam: `allowed-once` proceeds, everything
 * else materializes a refusal result the model can read and continue from.
 * @param ctx - the preset's plugin context (listener rides its fiber).
 */
export function installWriteApprovalGate(ctx: Context): void {
  ctx.on('tools/pre-execute', function (exec, next) {
    const reason = APPROVAL_REASONS[exec.name]
    if (reason === undefined) return next()
    return Promise.resolve({ kind: 'ask' as const, reason: reason(exec.arguments) })
  })
}

/** Narrow opaque result meta to the PR-create presentation meta, or undefined. */
export function prCreateMetaFromResult(meta: unknown): { number: number, created: boolean } | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { number, created } = meta as Record<string, unknown>
  if (typeof number !== 'number' || typeof created !== 'boolean') return undefined
  return { number, created }
}

/** Completed-call presentation for `github_pr_create`: created vs already-open. */
export function presentPrCreateResult(result: ToolResult): { card: 'generic', title: string } | undefined {
  if (result.isError) return undefined
  const meta = prCreateMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return { card: 'generic', title: meta.created ? `Created PR #${meta.number}` : `PR #${meta.number} already open` }
}

/**
 * Register the three write tools.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (timeout).
 */
export function applyGitHubWriteTools(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_issue_create',
    description: 'Create a GitHub issue. The user is asked to approve before anything is created.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      title: { type: 'string', required: true, description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body (markdown).' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created issue ${value.repo}#${value.number}: ${value.title}${value.url === undefined ? '' : `\n${value.url}`}`,
      }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const repo = parseRepoInput(args.repo)
      const issue = await runGitHub(() => ctx.github.createIssue({
        repo,
        title: args.title,
        ...args.body === undefined ? {} : { body: args.body },
        ...args.labels === undefined ? {} : { labels: args.labels },
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: issue.ref.number,
        title: issue.title,
        ...issue.ref.url === undefined ? {} : { url: issue.ref.url },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Create GitHub issue in ${args.repo}: ${args.title}`,
      kind: 'edit',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_issue_comment',
    description: 'Post a comment on a GitHub issue or pull request. The user is asked to approve before anything is posted.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Issue or pull request number.' },
      body: { type: 'string', required: true, description: 'Comment body (markdown).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Posted comment on ${value.repo}#${value.number}${value.url === undefined ? '' : `\n${value.url}`}`,
      }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const repo = parseRepoInput(args.repo)
      const comment = await runGitHub(() => ctx.github.createComment({
        item: { repo, number: args.number },
        body: args.body,
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: args.number,
        ...comment.url === undefined ? {} : { url: comment.url },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Comment on GitHub ${args.repo}#${args.number}`,
      kind: 'edit',
      rawInput: args.body,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_pr_create',
    description: 'Open a GitHub pull request from an existing branch. Idempotent: if an open PR for the same head/base already exists it is returned instead of failing. The user is asked to approve before anything is created.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      title: { type: 'string', required: true, description: 'Pull request title.' },
      head: { type: 'string', required: true, description: 'Source branch name.' },
      base: { type: 'string', required: true, description: 'Target branch name.' },
      body: { type: 'string', description: 'Pull request description (markdown).' },
      draft: { type: 'boolean', description: 'Open as a draft.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          url: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.created
          ? `Created pull request ${value.repo}#${value.number}: ${value.title}${value.url === undefined ? '' : `\n${value.url}`}`
          : `An open pull request for ${args.head} → ${args.base} already exists — returned it instead of creating a duplicate.\n${value.repo}#${value.number}: ${value.title}${value.url === undefined ? '' : `\n${value.url}`}`,
      }],
      presentationMeta: (_args, value) => ({ number: value.number, created: value.created }),
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const repo = parseRepoInput(args.repo)
      const result = await runGitHub(() => ctx.github.createPullRequest({
        repo,
        title: args.title,
        head: args.head,
        base: args.base,
        ...args.body === undefined ? {} : { body: args.body },
        ...args.draft === undefined ? {} : { draft: args.draft },
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: result.pullRequest.ref.number,
        title: result.pullRequest.title,
        created: result.created,
        ...result.pullRequest.ref.url === undefined ? {} : { url: result.pullRequest.ref.url },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Create GitHub PR in ${args.repo}: ${args.head} → ${args.base}`,
      kind: 'edit',
      rawInput: args,
    }),
    presentResult: (_args, result) => presentPrCreateResult(result),
  }))
}
