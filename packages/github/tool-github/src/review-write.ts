/**
 * The write half of the review loop (M10): submitting a review, updating a
 * pull request, assigning reviewers and labels, and listing pull requests.
 *
 * `github_pr_review_submit` carries the project's first operation with SOCIAL
 * consequence — `APPROVE` and `REQUEST_CHANGES` change a PR's blocking state
 * under the user's own name — so it is gated twice (ADR-0014): the
 * `reviewVerdicts` switch decides whether those two events exist in the schema
 * at all (default: they do not), and every submission still passes the approval
 * waterfall with a reason that names the event.
 * @module dsh-tool-github/review-write
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitHubReviewEvent, GitHubReviewSide } from 'dsh-github'
import { assertPositiveArg, parseRepoInput, preview, repoLabel, runGitHub, type ResolvedToolGitHubConfig } from './shared.ts'

/** Events that carry no verdict — always available. */
const COMMENT_ONLY: readonly GitHubReviewEvent[] = ['COMMENT']

/** Every event, including the two that change a PR's blocking state. */
const ALL_EVENTS: readonly GitHubReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']

/** The verdict-bearing events, i.e. the ones `reviewVerdicts` gates. */
export const REVIEW_VERDICT_EVENTS: ReadonlySet<string> = new Set(['APPROVE', 'REQUEST_CHANGES'])

/**
 * The events the model may choose from under this config.
 *
 * Narrowing happens in the SCHEMA, not at execution: with `reviewVerdicts` off
 * the model never sees that approving is possible, so it cannot try and be
 * refused (ADR-0014).
 * @param config - resolved plugin config.
 * @returns the allowed event names.
 */
export function allowedReviewEvents(config: ResolvedToolGitHubConfig): readonly GitHubReviewEvent[] {
  return config.reviewVerdicts ? ALL_EVENTS : COMMENT_ONLY
}

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

/** Count array-valued arguments defensively. */
function argCount(args: unknown, key: string): number {
  if (typeof args !== 'object' || args === null) return 0
  const value = (args as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.length : 0
}

/**
 * Approval reason for a review submission.
 *
 * A verdict reads differently from a comment on purpose: the user is being
 * asked to let an agent speak with their voice in a way collaborators will
 * treat as their judgement, and the prompt says exactly that. This wording is
 * the whole of the confirmation layer available here — the host's
 * `PreToolDecision` carries only a reason string, with no risk level to raise
 * (see the M10 implementation note in the execution plan).
 * @param args - raw tool arguments.
 * @returns the human-readable approval reason.
 */
export function reviewSubmitApprovalReason(args: unknown): string {
  const event = argString(args, 'event') ?? 'COMMENT'
  const target = `${argString(args, 'repo') ?? '?'}#${argNumber(args, 'number') ?? '?'}`
  const inline = argCount(args, 'comments')
  const inlineText = inline === 0 ? 'no inline comments' : `${inline} inline comment(s)`
  const body = preview(argString(args, 'body'))
  const summary = body === '' ? '' : ` — ${body}`
  if (REVIEW_VERDICT_EVENTS.has(event)) {
    return `Submit a ${event} review on ${target} under YOUR GitHub account (${inlineText}). `
      + `Collaborators will see this as your judgement, and it changes whether the PR is blocked.${summary}`
  }
  return `Submit a review comment on ${target} (${inlineText})${summary}`
}

/** Approval reason for a pull request field update. */
export function prUpdateApprovalReason(args: unknown): string {
  const target = `${argString(args, 'repo') ?? '?'}#${argNumber(args, 'number') ?? '?'}`
  const changes: string[] = []
  for (const field of ['title', 'body', 'base', 'state'] as const) {
    const value = argString(args, field)
    if (value !== undefined) changes.push(field === 'body' ? 'body' : `${field} → "${preview(value, 60)}"`)
  }
  return `Update GitHub PR ${target}: ${changes.length === 0 ? 'no fields' : changes.join(', ')}`
}

/** Approval reason for reviewer/label assignment. */
export function prAssignApprovalReason(args: unknown): string {
  const target = `${argString(args, 'repo') ?? '?'}#${argNumber(args, 'number') ?? '?'}`
  const parts: string[] = []
  const reviewers = argCount(args, 'reviewers')
  const labels = argCount(args, 'labels')
  if (reviewers > 0) parts.push(`request review from ${reviewers} user(s)`)
  if (labels > 0) parts.push(`${argString(args, 'label_mode') === 'set' ? 'replace' : 'add'} ${labels} label(s)`)
  return `Update GitHub PR ${target}: ${parts.length === 0 ? 'nothing to change' : parts.join(', ')}`
}

/**
 * Register `github_pr_list` — a READ tool, so it is not gated by `write`.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config.
 */
export function applyGitHubPrListTool(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_pr_list',
    description: 'List pull requests of a repository, optionally filtered by state and by head/base branch. Returns lean rows; pass a number to github_pr_read for detail.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Lifecycle filter; defaults to open.' },
      head: { type: 'string', description: 'Filter by source branch name.' },
      base: { type: 'string', description: 'Filter by target branch name.' },
      max_results: { type: 'integer', description: 'Upper bound on returned pull requests.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          pullRequests: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                state: { type: 'string', required: true },
                headRef: { type: 'string', required: true },
                baseRef: { type: 'string', required: true },
                author: { type: 'string' },
                draft: { type: 'boolean' },
                url: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatPrList(value) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.max_results !== undefined) assertPositiveArg('max_results', args.max_results)
      const repo = parseRepoInput(args.repo)
      const bound = Math.min(args.max_results ?? config.searchMaxResults, config.searchMaxResults)
      const items = await runGitHub(() => ctx.github.listPullRequests({
        repo,
        ...args.state === undefined ? {} : { state: args.state as 'open' | 'closed' | 'all' },
        ...args.head === undefined ? {} : { head: args.head },
        ...args.base === undefined ? {} : { base: args.base },
        maxResults: bound,
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        pullRequests: items.map(pr => ({
          number: pr.ref.number,
          title: pr.title,
          state: pr.state,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          ...pr.author === undefined ? {} : { author: pr.author },
          ...pr.draft === undefined ? {} : { draft: pr.draft },
          ...pr.ref.url === undefined ? {} : { url: pr.ref.url },
        })),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `List GitHub pull requests in ${args.repo}`,
      kind: 'read',
      rawInput: args.repo,
    }),
  }))
}

/** One pull request per line, lean enough to scan. */
export function formatPrList(value: {
  repo: string
  pullRequests: readonly { number: number, title: string, state: string, headRef: string, baseRef: string, author?: string, draft?: boolean }[]
}): string {
  if (value.pullRequests.length === 0) return `No pull requests in ${value.repo} for that filter.`
  const rows = value.pullRequests.map(pr => {
    const draft = pr.draft === true ? ' (draft)' : ''
    const author = pr.author === undefined ? '' : ` · ${pr.author}`
    return `- #${pr.number} [${pr.state}${draft}] ${pr.title} · ${pr.headRef} → ${pr.baseRef}${author}`
  })
  return `Pull requests in ${value.repo} (${value.pullRequests.length}):\n${rows.join('\n')}`
}

/**
 * Register the review-write tools: submission, field updates, and assignment.
 * All three are approval-gated writes and only register when `write` is on.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (`reviewVerdicts` narrows the event enum).
 */
export function applyGitHubReviewWriteTools(ctx: Context, config: ResolvedToolGitHubConfig): void {
  const events = allowedReviewEvents(config)
  const verdictHint = config.reviewVerdicts
    ? ' APPROVE and REQUEST_CHANGES speak with the user\'s own voice and change whether the PR is blocked — prefer COMMENT unless the user asked for a verdict. GitHub refuses either one on the user\'s own pull request.'
    : ' Only COMMENT is available in this deployment; approving and requesting changes are switched off.'

  ctx.tools.register(defineTool({
    name: 'github_pr_review_submit',
    description: `Submit a review on a GitHub pull request, with an optional summary and inline comments anchored to file lines.${verdictHint} The user is asked to approve before anything is posted.`,
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Pull request number.' },
      event: {
        type: 'string',
        required: true,
        enum: [...events],
        description: 'What the review does.',
      },
      body: { type: 'string', description: 'Overall review summary (markdown).' },
      comments: {
        type: 'array',
        description: 'Inline comments, each anchored to a file and line of the diff.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            line: { type: 'integer', required: true },
            side: { type: 'string', enum: ['left', 'right'] },
            body: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          event: { type: 'string', required: true },
          state: { type: 'string', required: true },
          commentCount: { type: 'integer', required: true },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Submitted a ${value.event} review on ${value.repo}#${value.number} (${value.commentCount} inline comment(s)); it now reads as ${value.state}.`
          + `${value.url === undefined ? '' : `\n${value.url}`}`,
      }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      assertPositiveArg('number', args.number)
      const repo = parseRepoInput(args.repo)
      const comments = (args.comments ?? []) as { path: string, line: number, side?: GitHubReviewSide, body: string }[]
      const review = await runGitHub(() => ctx.github.submitReview({
        item: { repo, number: args.number },
        event: args.event as GitHubReviewEvent,
        ...args.body === undefined ? {} : { body: args.body },
        ...comments.length === 0 ? {} : {
          comments: comments.map(comment => ({
            path: comment.path,
            line: comment.line,
            body: comment.body,
            ...comment.side === undefined ? {} : { side: comment.side },
          })),
        },
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: args.number,
        event: args.event,
        state: review.state,
        commentCount: comments.length,
        ...review.url === undefined ? {} : { url: review.url },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Submit ${args.event} review on GitHub PR ${args.repo}#${args.number}`,
      kind: 'edit',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_pr_update',
    description: 'Update a GitHub pull request\'s title, body, base branch, or open/closed state. Draft status cannot be changed through this API. The user is asked to approve first.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Pull request number.' },
      title: { type: 'string', description: 'New title.' },
      body: { type: 'string', description: 'New description (markdown).' },
      base: { type: 'string', description: 'Retarget at this base branch.' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'Reopen or close the pull request.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          state: { type: 'string', required: true },
          baseRef: { type: 'string', required: true },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated ${value.repo}#${value.number}: "${value.title}" [${value.state}] → ${value.baseRef}${value.url === undefined ? '' : `\n${value.url}`}`,
      }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      assertPositiveArg('number', args.number)
      const repo = parseRepoInput(args.repo)
      const pr = await runGitHub(() => ctx.github.updatePullRequest({
        item: { repo, number: args.number },
        ...args.title === undefined ? {} : { title: args.title },
        ...args.body === undefined ? {} : { body: args.body },
        ...args.base === undefined ? {} : { base: args.base },
        ...args.state === undefined ? {} : { state: args.state as 'open' | 'closed' },
      }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: pr.ref.number,
        title: pr.title,
        state: pr.state,
        baseRef: pr.baseRef,
        ...pr.ref.url === undefined ? {} : { url: pr.ref.url },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Update GitHub PR ${args.repo}#${args.number}`,
      kind: 'edit',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_pr_assign',
    description: 'Request review from users and/or apply labels on a GitHub pull request. The user is asked to approve first.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/repo.' },
      number: { type: 'integer', required: true, description: 'Pull request number.' },
      reviewers: { type: 'array', items: { type: 'string' }, description: 'GitHub logins to request review from.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply.' },
      label_mode: { type: 'string', enum: ['add', 'set'], description: 'add keeps existing labels (default); set replaces them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          number: { type: 'integer', required: true },
          reviewersRequested: { type: 'array', required: true, items: { type: 'string' } },
          labels: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Updated ${value.repo}#${value.number}.`,
          value.reviewersRequested.length === 0 ? undefined : `Review requested from: ${value.reviewersRequested.join(', ')}`,
          value.labels.length === 0 ? undefined : `Labels now: ${value.labels.join(', ')}`,
        ].filter((line): line is string => line !== undefined).join('\n'),
      }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      assertPositiveArg('number', args.number)
      const repo = parseRepoInput(args.repo)
      const item = { repo, number: args.number }
      const reviewers = args.reviewers ?? []
      if (reviewers.length > 0) {
        await runGitHub(() => ctx.github.requestReviewers({ item, reviewers }, exec.signal))
      }
      const requested = args.labels ?? []
      const labels = requested.length === 0
        ? []
        : await runGitHub(() => ctx.github.setLabels({
          item,
          labels: requested,
          ...args.label_mode === undefined ? {} : { mode: args.label_mode as 'add' | 'set' },
        }, exec.signal))
      return {
        repo: repoLabel(repo),
        number: args.number,
        reviewersRequested: [...reviewers],
        labels: [...labels],
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Assign on GitHub PR ${args.repo}#${args.number}`,
      kind: 'edit',
      rawInput: args,
    }),
  }))
}
