import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRegistry, type ToolExecutionResult, type ToolResult } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import GitHubRuntime, {
  GitHubError,
  type GitHubComment,
  type GitHubProvider,
  type GitHubSearchRequest,
} from 'dsh-github'
import * as toolGitHub from 'dsh-tool-github'
import {
  allowedReviewEvents,
  formatChecks,
  formatCiFailures,
  formatPrList,
  formatReviewBrief,
  formatReviews,
  prAssignApprovalReason,
  prUpdateApprovalReason,
  reviewSubmitApprovalReason,
  type ReviewBriefValue,
  formatComments,
  formatDiff,
  formatSearchOutput,
  parseRepoInput,
  presentPrCreateResult,
  presentSearchResult,
  preview,
  renderPrRead,
  searchCallTitle,
  toModelError,
} from 'dsh-tool-github'
import * as toolInvariant from 'dsh-tool-github/invariant'

const agent = { name: 'tester' } as unknown as Agent

/** A scriptable provider; every operation defaults to a small canned answer. */
function makeProvider(overrides: Partial<GitHubProvider> = {}): GitHubProvider & { searches: GitHubSearchRequest[] } {
  const searches: GitHubSearchRequest[] = []
  return {
    searches,
    id: 'fake',
    available: () => true,
    search(request) {
      searches.push(request)
      return Promise.resolve({
        items: [{ title: 'Crash on start', url: 'https://x/7', repo: { owner: 'octo', repo: 'hello-world' }, number: 7, state: 'open' }],
        truncated: false,
      })
    },
    getIssue: ref => Promise.resolve({
      ref: { ...ref, url: `https://github.com/octo/hello-world/issues/${ref.number}` },
      title: 'Crash on start',
      state: 'open',
      body: 'It crashes.',
      author: 'octocat',
      labels: ['bug'],
    }),
    getPullRequest: ref => Promise.resolve({
      ref: { ...ref, url: `https://github.com/octo/hello-world/pull/${ref.number}` },
      title: 'Add feature',
      state: 'open',
      baseRef: 'main',
      headRef: 'feat/x',
      body: 'Please review.',
      author: 'octocat',
    }),
    getComments: () => Promise.resolve([
      { id: 1, body: 'Looks good', author: 'octocat', createdAt: '2026-08-04' },
      { id: 2, body: 'ping' },
      { id: 3, body: 'third' },
    ] as GitHubComment[]),
    getDiff: () => Promise.resolve({
      files: [
        { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' as const, additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@' },
        { path: 'logo.png', status: 'changed' as const, additions: 0, deletions: 0 },
      ],
      truncated: false,
    }),
    getChecks: () => Promise.resolve({
      runs: [
        { name: 'ci', status: 'completed' as const, conclusion: 'success' as const, url: 'https://x/runs/1' },
        { name: 'lint', status: 'in_progress' as const },
      ],
    }),
    getReviews: () => Promise.resolve([
      { id: 11, state: 'approved' as const, author: 'alice', body: 'LGTM', submittedAt: '2026-08-04' },
      { id: 12, state: 'changes-requested' as const, author: 'bob' },
    ]),
    getReviewComments: () => Promise.resolve([
      { id: 21, path: 'src/a.ts', body: 'this leaks', side: 'right' as const, line: 42, author: 'bob', createdAt: '2026-08-04' },
      { id: 22, path: 'src/b.ts', body: 'stale note', side: 'left' as const, diffHunk: '@@ -1 +1 @@' },
      { id: 23, path: 'src/c.ts', body: 'third', side: 'right' as const, line: 7 },
    ]),
    getCheckFailures: () => Promise.resolve({
      failures: [
        {
          run: { name: 'build', status: 'completed' as const, conclusion: 'failure' as const },
          annotations: [{ path: 'src/a.ts', level: 'failure' as const, message: 'TS2345', title: 'tsc', startLine: 10, endLine: 12 }],
        },
        {
          run: { name: 'test', status: 'completed' as const, conclusion: 'failure' as const },
          annotations: [],
          log: { text: 'exit 1', truncated: true },
        },
        { run: { name: 'scan', status: 'completed' as const, conclusion: 'timed_out' as const }, annotations: [] },
      ],
      truncated: false,
    }),
    getMergeability: () => Promise.resolve({ mergeable: true, state: 'clean' as const, blockedBy: [] }),
    listPullRequests: request => Promise.resolve([
      {
        ref: { repo: request.repo, number: 5, url: 'https://x/pull/5' },
        title: 'Add feature',
        state: 'open' as const,
        baseRef: 'main',
        headRef: 'feat/x',
        author: 'octocat',
      },
      {
        ref: { repo: request.repo, number: 6 },
        title: 'WIP',
        state: 'open' as const,
        baseRef: 'main',
        headRef: 'feat/y',
        draft: true,
      },
    ]),
    submitReview: request => Promise.resolve({
      id: 11,
      state: request.event === 'APPROVE' ? 'approved' as const : request.event === 'REQUEST_CHANGES' ? 'changes-requested' as const : 'commented' as const,
      url: 'https://x/pull/5#pullrequestreview-11',
    }),
    updatePullRequest: request => Promise.resolve({
      ref: { ...request.item, url: 'https://x/pull/5' },
      title: request.title ?? 'Add feature',
      state: request.state === 'closed' ? 'closed' as const : 'open' as const,
      baseRef: request.base ?? 'main',
      headRef: 'feat/x',
    }),
    requestReviewers: () => Promise.resolve(),
    setLabels: request => Promise.resolve([...request.labels]),
    createIssue: request => Promise.resolve({
      ref: { repo: request.repo, number: 9, url: 'https://github.com/octo/hello-world/issues/9' },
      title: request.title,
      state: 'open' as const,
    }),
    createComment: () => Promise.resolve({ id: 5, body: 'done', url: 'https://x/comment/5' }),
    createPullRequest: request => Promise.resolve({
      pullRequest: {
        ref: { repo: request.repo, number: 5, url: 'https://github.com/octo/hello-world/pull/5' },
        title: request.title,
        state: 'open' as const,
        baseRef: request.base,
        headRef: request.head,
      },
      created: true,
    }),
    ...overrides,
  }
}

/** Scripted approval service standing in for the host's ApprovalPanel wiring. */
class FakeApproval extends Service {
  outcomes: ('allowed-once' | 'rejected' | 'cancelled' | 'unavailable')[] = []
  requests: { toolName: string, reason?: string }[] = []

  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  request(req: { toolName: string, reason?: string }): Promise<string> {
    this.requests.push({ toolName: req.toolName, ...req.reason === undefined ? {} : { reason: req.reason } })
    return Promise.resolve(this.outcomes.shift() ?? 'allowed-once')
  }
}

interface Suite {
  ctx: Context
  provider: ReturnType<typeof makeProvider>
  approval?: FakeApproval
  run(name: string, args: unknown, options?: { withAgent?: boolean }): Promise<ToolExecutionResult>
}

async function mountSuite(config: toolGitHub.Config = {}, options: { approval?: boolean, provider?: Partial<GitHubProvider> } = {}): Promise<Suite> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry, {})
  await ctx.plugin(GitHubRuntime)
  let approval: FakeApproval | undefined
  if (options.approval === true) {
    await ctx.plugin(FakeApproval)
    approval = ctx.get('approval') as FakeApproval
  }
  const provider = makeProvider(options.provider)
  ctx.github.registerProvider(provider)
  await ctx.plugin(toolGitHub, config)
  let calls = 0
  return {
    ctx,
    provider,
    ...approval === undefined ? {} : { approval },
    run: (name, args, runOptions = {}) => ctx.tools.execute({
      callId: CallId(`call-${calls++}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      ...runOptions.withAgent === true ? { agent } : {},
    }),
  }
}

function text(result: ToolExecutionResult): string {
  const [block] = result.content
  return block !== undefined && block.type === 'text' ? block.text : ''
}

const ok = (result: ToolExecutionResult): string => {
  // Surface the tool's own message on failure; a bare `isError` mismatch says
  // nothing about WHY the call failed.
  if (result.isError) expect.fail(`expected the tool to succeed, but it failed with: ${text(result)}`)
  return text(result)
}

// —— plugin shape and config ——————————————————————————————————————————————————

describe('dsh-tool-github plugin', () => {
  it('exports a function plugin without a default export (engineering gate §8)', () => {
    expect(toolGitHub.name).toBe('tool-github')
    expect(toolGitHub.inject).toEqual(['tools', 'github', 'systemPrompt'])
    expect('default' in toolGitHub).toBe(false)
  })

  it('registers read and write tools by default', async () => {
    const { ctx } = await mountSuite()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('github_search')
    expect(names).toContain('github_issue_read')
    expect(names).toContain('github_pr_read')
    expect(names).toContain('github_issue_create')
    expect(names).toContain('github_issue_comment')
    expect(names).toContain('github_pr_create')
  })

  it('keeps write tools out of the catalog when write is off (M4 DoD)', async () => {
    const { ctx } = await mountSuite({ write: false })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('github_search')
    expect(names).not.toContain('github_issue_create')
    expect(names).not.toContain('github_issue_comment')
    expect(names).not.toContain('github_pr_create')
  })

  it('rejects a non-positive config bound at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry, {})
    await ctx.plugin(GitHubRuntime)
    await expect(ctx.plugin(toolGitHub, { searchMaxResults: 0 })).rejects.toThrow(/searchMaxResults/)
  })
})

// —— github_search ————————————————————————————————————————————————————————————

describe('github_search', () => {
  it('searches through the seam with the configured bound and renders lean hits', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_search', { kind: 'issues', query: 'crash' })
    expect(suite.provider.searches[0]).toEqual({ kind: 'issues', query: 'crash', maxResults: 8 })
    expect(ok(result)).toBe('- octo/hello-world#7 [open] Crash on start\n  https://x/7')
  })

  it('caps max_results at the deployment bound and honors a lower request', async () => {
    const suite = await mountSuite({ searchMaxResults: 5 })
    await suite.run('github_search', { kind: 'code', query: 'q', max_results: 50 })
    await suite.run('github_search', { kind: 'code', query: 'q', max_results: 2 })
    expect(suite.provider.searches.map(request => request.maxResults)).toEqual([5, 2])
  })

  it('rejects a blank query and a non-positive max_results as model-visible errors', async () => {
    const suite = await mountSuite()
    const blank = await suite.run('github_search', { kind: 'issues', query: '  ' })
    expect(blank.isError).toBe(true)
    expect(text(blank)).toMatch(/query must be a non-empty string/)
    const bad = await suite.run('github_search', { kind: 'issues', query: 'q', max_results: 0 })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/max_results must be a positive integer/)
  })

  it('renders the truncation hint from an over-full provider result', async () => {
    const suite = await mountSuite({}, {
      provider: {
        search: () => Promise.resolve({ items: [{ title: 'octo/hello-world', url: 'https://x/r', snippet: 'demo' }], truncated: true }),
      },
    })
    const result = await suite.run('github_search', { kind: 'repositories', query: 'hello' })
    expect(ok(result)).toBe('- octo/hello-world — demo\n  https://x/r\n\n(Result list truncated. Refine the query or read items directly.)')
  })

  it('presents the pending call per kind and falls back on an unknown kind', () => {
    expect(searchCallTitle('issues', 'q')).toBe('Search GitHub issues: q')
    expect(searchCallTitle('pull-requests', 'q')).toBe('Search GitHub pull requests: q')
    expect(searchCallTitle('repositories', 'q')).toBe('Search GitHub repositories: q')
    expect(searchCallTitle('code', 'q')).toBe('Search GitHub code: q')
    expect(() => searchCallTitle('bogus' as never, 'q')).toThrow()
  })

  it('formats the empty result and mixed hit shapes', () => {
    expect(formatSearchOutput({ items: [], truncated: false })).toBe('No results found.')
    expect(formatSearchOutput({
      items: [
        { title: 'A', url: 'u1', repo: 'o/r', number: 1 },
        { title: 'B', url: 'u2' },
      ],
      truncated: false,
    })).toBe('- o/r#1 A\n  u1\n- B\n  u2')
  })

  it('exposes call and result presenters through the registry', async () => {
    const { ctx } = await mountSuite()
    const definition = ctx.tools.get('github_search')!
    expect(definition.presentCall!({ kind: 'issues', query: 'crash' })).toMatchObject({ card: 'generic', kind: 'search', title: 'Search GitHub issues: crash' })
    const success: ToolResult = { content: [], isError: false, meta: { count: 2, truncated: true } }
    expect(definition.presentResult!({ kind: 'issues', query: 'crash' }, success)).toEqual({ card: 'generic', title: '2 GitHub results (truncated)' })
  })

  it('narrows presentation meta defensively', () => {
    const failure: ToolResult = { content: [], isError: true }
    expect(presentSearchResult(failure)).toBeUndefined()
    expect(presentSearchResult({ content: [], isError: false })).toBeUndefined()
    expect(presentSearchResult({ content: [], isError: false, meta: [1] })).toBeUndefined()
    expect(presentSearchResult({ content: [], isError: false, meta: { count: 'x', truncated: true } as never })).toBeUndefined()
    expect(presentSearchResult({ content: [], isError: false, meta: { count: 1, truncated: false } })).toEqual({ card: 'generic', title: '1 GitHub result' })
  })
})

// —— error translation ————————————————————————————————————————————————————————

describe('model-facing error translation', () => {
  it('turns a rate limit into a wait hint carrying retryAfterMs', async () => {
    const suite = await mountSuite({}, {
      provider: { search: () => Promise.reject(new GitHubError('slow down', 'GITHUB_RATE_LIMITED', { retryAfterMs: 90_000 })) },
    })
    const result = await suite.run('github_search', { kind: 'issues', query: 'q' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/rate limit hit\. Wait ~90s/)
  })

  it.each([
    ['rate limit without retryAfterMs', new GitHubError('x', 'GITHUB_RATE_LIMITED'), /Wait a moment/],
    ['auth failure', new GitHubError('x', 'GITHUB_AUTH'), /connect GitHub/],
    ['not found', new GitHubError('x', 'GITHUB_NOT_FOUND'), /check the owner\/repo and number/],
  ])('translates a %s', (_label, error, expected) => {
    expect((toModelError(error) as Error).message).toMatch(expected)
  })

  it('passes other GitHub codes and foreign errors through unchanged', () => {
    const validation = new GitHubError('bad request', 'GITHUB_VALIDATION')
    expect(toModelError(validation)).toBe(validation)
    const foreign = new Error('boom')
    expect(toModelError(foreign)).toBe(foreign)
  })
})

// —— github_issue_read ————————————————————————————————————————————————————————

describe('github_issue_read', () => {
  it('renders the issue with capped comments', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_issue_read', { repo: 'octo/hello-world', number: 7, max_comments: 2 })
    expect(ok(result)).toBe([
      '### octo/hello-world#7: Crash on start',
      'State: open · Author: octocat · Labels: bug',
      '',
      'It crashes.',
      '',
      'Comments (showing 2 of 3; raise max_comments for more):',
      '- octocat, 2026-08-04: Looks good',
      '- unknown: ping',
    ].join('\n'))
  })

  it('renders a minimal issue with no comments', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getIssue: ref => Promise.resolve({ ref, title: 'Old one', state: 'closed' as const }),
        getComments: () => Promise.resolve([]),
      },
    })
    const result = await suite.run('github_issue_read', { repo: 'octo/hello-world', number: 8 })
    expect(ok(result)).toBe('### octo/hello-world#8: Old one\nState: closed\n\n(no description)\n\nNo comments.')
  })

  it('omits the empty labels list from the header', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getIssue: ref => Promise.resolve({ ref, title: 'Old one', state: 'closed' as const, labels: [] }),
        getComments: () => Promise.resolve([]),
      },
    })
    const result = await suite.run('github_issue_read', { repo: 'octo/hello-world', number: 8 })
    expect(ok(result)).toContain('State: closed\n')
    expect(ok(result)).not.toContain('Labels:')
  })

  it('shows all comments without the raise hint when under the cap', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_issue_read', { repo: 'octo/hello-world', number: 7 })
    expect(ok(result)).toContain('Comments (3):')
  })

  it.each([
    ['a bad repo shape', { repo: 'not-a-repo', number: 7 }, /repo must be "owner\/repo"/],
    ['a non-positive number', { repo: 'octo/hello-world', number: 0 }, /number must be a positive integer/],
    ['a non-positive max_comments', { repo: 'octo/hello-world', number: 7, max_comments: -1 }, /max_comments must be a positive integer/],
  ])('rejects %s', async (_label, args, expected) => {
    const suite = await mountSuite()
    const result = await suite.run('github_issue_read', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(expected)
  })

  it('presents the pending read', async () => {
    const { ctx } = await mountSuite()
    expect(ctx.tools.get('github_issue_read')!.presentCall!({ repo: 'octo/hello-world', number: 7 }))
      .toMatchObject({ kind: 'read', title: 'Read GitHub issue octo/hello-world#7' })
  })
})

// —— github_pr_read ———————————————————————————————————————————————————————————

describe('github_pr_read', () => {
  it('reads metadata by default', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5 })
    expect(ok(result)).toBe([
      '### octo/hello-world#5: Add feature',
      'State: open · Branches: feat/x → main · Author: octocat',
      '',
      'Please review.',
    ].join('\n'))
  })

  it('marks a draft PR and tolerates a bodyless one', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getPullRequest: ref => Promise.resolve({ ref, title: 'WIP', state: 'open' as const, baseRef: 'main', headRef: 'feat/y', draft: true }),
      },
    })
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 6, part: 'metadata' })
    expect(ok(result)).toBe('### octo/hello-world#6: WIP\nState: open (draft) · Branches: feat/y → main\n\n(no description)')
  })

  it('reads the diff under the tool-owned budgets', async () => {
    const budgets: unknown[] = []
    const suite = await mountSuite({ diffMaxFiles: 2, diffMaxPatchChars: 100 }, {
      provider: {
        getDiff: (_item, request) => {
          budgets.push(request)
          return Promise.resolve({
            files: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '+a' }],
            truncated: true,
          })
        },
      },
    })
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'diff' })
    expect(budgets[0]).toEqual({ maxFiles: 2, maxPatchChars: 100 })
    expect(ok(result)).toBe([
      '--- a.ts · modified · +1/-0',
      '```diff',
      '+a',
      '```',
      '',
      '(Diff truncated by budget. Ask for specific files or a narrower part.)',
    ].join('\n'))
  })

  it('renders renamed and patch-less files without a truncation note when complete', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'diff' })
    expect(ok(result)).toBe([
      '--- src/new.ts (from src/old.ts) · renamed · +3/-1',
      '```diff',
      '@@ -1 +1,3 @@',
      '```',
      '--- logo.png · changed · +0/-0',
    ].join('\n'))
  })

  it('reads capped comments', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'comments', max_comments: 1 })
    expect(ok(result)).toBe('Comments (showing 1 of 3; raise max_comments for more):\n- octocat, 2026-08-04: Looks good')
  })

  it('reads checks with a mixed verdict', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'checks' })
    expect(ok(result)).toBe('Checks (1 still running):\n- ci: success\n- lint: in_progress')
  })

  it('presents the pending read with its part', async () => {
    const { ctx } = await mountSuite()
    const definition = ctx.tools.get('github_pr_read')!
    expect(definition.presentCall!({ repo: 'o/r', number: 5, part: 'diff' })).toMatchObject({ title: 'Read GitHub PR o/r#5 (diff)' })
    expect(definition.presentCall!({ repo: 'o/r', number: 5 })).toMatchObject({ title: 'Read GitHub PR o/r#5 (metadata)' })
  })

  it('reads submitted reviews together with the line-anchored comments (M8)', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'reviews' })
    expect(ok(result)).toBe([
      'Reviews (2):',
      '- alice, 2026-08-04 — approved',
      '  LGTM',
      '- bob — changes-requested',
      '',
      'Line comments (3):',
      '- src/a.ts:42 · bob (right): this leaks',
      // An outdated comment lost its line, so the hunk is carried as the only anchor left.
      '- src/b.ts (outdated) · unknown (left): stale note',
      '```diff',
      '@@ -1 +1 @@',
      '```',
      '- src/c.ts:7 · unknown (right): third',
    ].join('\n'))
  })

  it('omits every absent optional field on reviews, comments, and annotations', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getReviews: () => Promise.resolve([{ id: 1, state: 'dismissed' as const }]),
        getReviewComments: () => Promise.resolve([{ id: 2, path: 'src/a.ts', body: 'bare', side: 'right' as const }]),
        getCheckFailures: () => Promise.resolve({
          failures: [{
            run: { name: 'bare', status: 'completed' as const },
            annotations: [{ path: 'src/a.ts', level: 'notice' as const, message: 'plain' }],
          }],
          truncated: false,
        }),
      },
    })
    expect(ok(await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'reviews' }))).toBe([
      'Reviews (1):',
      '- unknown — dismissed',
      '',
      'Line comments (1):',
      '- src/a.ts (outdated) · unknown (right): bare',
    ].join('\n'))
    expect(ok(await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'ci-failures' }))).toBe([
      'CI failures (1):',
      '- bare: failure',
      '  ! src/a.ts [notice] plain',
    ].join('\n'))
  })

  it('caps review comments the same way conversation comments are capped', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'reviews', max_comments: 1 })
    expect(ok(result)).toContain('Line comments (showing 1 of 3; raise max_comments for more):')
  })

  it('reads CI failures, preferring annotations and falling back to the log tail (M8)', async () => {
    const budgets: unknown[] = []
    const suite = await mountSuite({ logMaxLines: 20, logMaxChars: 500 }, {
      provider: {
        getCheckFailures: (_item, request) => {
          budgets.push(request)
          return Promise.resolve({
            failures: [{
              run: { name: 'build', status: 'completed' as const, conclusion: 'failure' as const },
              annotations: [],
              log: { text: 'exit 1', truncated: true },
            }],
            truncated: true,
          })
        },
      },
    })
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'ci-failures' })
    expect(budgets[0]).toEqual({ maxLogLines: 20, maxLogChars: 500 })
    expect(ok(result)).toBe([
      'CI failures (1):',
      '- build: failure',
      '  Log (tail, truncated):',
      '```',
      'exit 1',
      '```',
      '(Evidence truncated by budget. Open the run on GitHub for the full log.)',
    ].join('\n'))
  })

  it('renders all three evidence shapes in one failure read', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_read', { repo: 'octo/hello-world', number: 5, part: 'ci-failures' })
    expect(ok(result)).toBe([
      'CI failures (3):',
      '- build: failure',
      '  ! src/a.ts:10 [failure] tsc: TS2345',
      '',
      '- test: failure',
      '  Log (tail, truncated):',
      '```',
      'exit 1',
      '```',
      '',
      '- scan: timed_out',
      '  No annotations, and no log is available (expired, or not a GitHub Actions check).',
      // The provider reported result.truncated=false, but one log carried
      // truncated=true — the seam lifts that upward, so the note appears anyway.
      '(Evidence truncated by budget. Open the run on GitHub for the full log.)',
    ].join('\n'))
  })
})

describe('github_pr_review (M9)', () => {
  it('assembles the review task: diff once, routed dimensions, severity, contract', async () => {
    const budgets: unknown[] = []
    const suite = await mountSuite({ reviewMaxFiles: 7, reviewMaxPatchChars: 700 }, {
      provider: {
        getDiff: (_item, request) => {
          budgets.push(request)
          return Promise.resolve({
            files: [
              { path: 'src/a.ts', status: 'modified' as const, additions: 2, deletions: 1, patch: '+try { go() } catch (e) {}' },
              { path: 'src/a.test.ts', status: 'added' as const, additions: 5, deletions: 0, patch: '+expect(go()).toBe(1)' },
            ],
            truncated: false,
          })
        },
      },
    })
    const rendered = ok(await suite.run('github_pr_review', { repo: 'octo/hello-world', number: 5 }))

    expect(budgets[0]).toEqual({ maxFiles: 7, maxPatchChars: 700 })
    expect(rendered).toContain('## Review task: octo/hello-world#5')
    expect(rendered).toContain('## Dimensions (4 apply)')
    expect(rendered).toContain('### error-handling')
    expect(rendered).toContain('Applies because: 1 test file(s) changed. Files: src/a.test.ts, src/a.ts')
    expect(rendered).toContain('- **blocker** —')
    expect(rendered).toContain('## Report every finding like this')
    // The one hunk is printed once, in the diff section — not repeated per dimension.
    expect(rendered.split('+try { go() } catch (e) {}')).toHaveLength(2)
  })

  it('passes a caller dimension restriction through to the seam', async () => {
    const suite = await mountSuite()
    const rendered = ok(await suite.run('github_pr_review', {
      repo: 'octo/hello-world',
      number: 5,
      dimensions: ['correctness'],
    }))
    expect(rendered).toContain('## Dimensions (1 apply)')
    expect(rendered).toContain('### correctness')
    expect(rendered).not.toContain('### simplification')
  })

  it('says there is nothing to review rather than inventing dimensions', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getDiff: () => Promise.resolve({
          files: [{ path: 'assets/logo.png', status: 'modified' as const, additions: 0, deletions: 0 }],
          truncated: false,
        }),
      },
    })
    const rendered = ok(await suite.run('github_pr_review', { repo: 'octo/hello-world', number: 5 }))
    expect(rendered).toContain('Nothing routable changed')
    expect(rendered).not.toContain('## Dimensions (')
  })

  it('warns that a truncated diff makes the review knowingly partial, and carries draft state', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getPullRequest: ref => Promise.resolve({
          ref, title: 'WIP', state: 'open' as const, baseRef: 'main', headRef: 'feat/x', draft: true,
        }),
        getDiff: () => Promise.resolve({
          files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '+const a = 1' }],
          truncated: true,
        }),
      },
    })
    const rendered = ok(await suite.run('github_pr_review', { repo: 'octo/hello-world', number: 5 }))
    expect(rendered).toContain('knowingly partial')
    expect(rendered).toContain('State: open (draft)')
  })

  it('registers as a read tool, present included, and survives write: false', async () => {
    const suite = await mountSuite({ write: false })
    const definition = suite.ctx.tools.get('github_pr_review')!
    expect(definition).toBeDefined()
    expect(definition.isConcurrencySafe!({ repo: 'o/r', number: 5 })).toBe(true)
    expect(definition.presentCall!({ repo: 'o/r', number: 5 }))
      .toMatchObject({ title: 'Assemble review of GitHub PR o/r#5', kind: 'read' })
  })

  it('rejects a non-positive PR number before reaching the seam', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_pr_review', { repo: 'octo/hello-world', number: 0 })
    expect(result.isError).toBe(true)
  })

  it('omits every absent optional field of a bare pull request', async () => {
    const suite = await mountSuite({}, {
      provider: {
        getPullRequest: ref => Promise.resolve({ ref, title: 'Bare', state: 'open' as const, baseRef: 'main', headRef: 'feat/x' }),
        getDiff: () => Promise.resolve({
          files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '+const a = 1' }],
          truncated: false,
        }),
      },
    })
    const rendered = ok(await suite.run('github_pr_review', { repo: 'octo/hello-world', number: 5 }))
    expect(rendered).toContain('### octo/hello-world#5: Bare')
    expect(rendered).toContain('(no description)')
    expect(rendered).not.toContain('Author:')
  })

  it('renders a pathless dimension as covering the whole diff', () => {
    const brief: ReviewBriefValue = {
      pullRequest: { repo: 'o/r', number: 1, title: 'T', state: 'open', headRef: 'h', baseRef: 'b' },
      diff: { files: [], truncated: false },
      dimensions: [{ dimension: 'correctness', reason: 'everything changed', paths: [], checklist: ['Does it work?'] }],
      severityScale: [{ level: 'blocker', meaning: 'stop' }],
      outputContract: ['point at a line'],
      truncated: false,
    }
    expect(formatReviewBrief(brief)).toContain('Applies because: everything changed. Files: the whole diff')
  })
})

describe('review verdicts gate (ADR-0014)', () => {
  /** The event names the model can actually see — read off the emitted JSON Schema. */
  function eventEnum(ctx: Suite['ctx']): unknown {
    const definition = ctx.tools.get('github_pr_review_submit')!
    const schema = definition.parameters as { properties?: { event?: { enum?: unknown } } }
    return schema.properties?.event?.enum
  }

  it('hides APPROVE and REQUEST_CHANGES from the schema by default', async () => {
    const { ctx } = await mountSuite()
    expect(eventEnum(ctx)).toEqual(['COMMENT'])
    expect(ctx.tools.get('github_pr_review_submit')!.description).toContain('switched off')
  })

  it('exposes all three events only when reviewVerdicts is switched on', async () => {
    const { ctx } = await mountSuite({ reviewVerdicts: true })
    expect(eventEnum(ctx)).toEqual(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])
    expect(ctx.tools.get('github_pr_review_submit')!.description).toContain('user\'s own voice')
  })

  it('keeps the default off, so a deployment must opt in deliberately', () => {
    expect(toolGitHub.Config({}).reviewVerdicts).toBe(false)
    expect(allowedReviewEvents({ reviewVerdicts: false } as never)).toEqual(['COMMENT'])
    expect(allowedReviewEvents({ reviewVerdicts: true } as never)).toEqual(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])
  })

  it('registers no review-write tool at all when writes are off', async () => {
    const { ctx } = await mountSuite({ write: false, reviewVerdicts: true })
    expect(ctx.tools.get('github_pr_review_submit')).toBeUndefined()
    expect(ctx.tools.get('github_pr_update')).toBeUndefined()
    expect(ctx.tools.get('github_pr_assign')).toBeUndefined()
    // ...but the read-only listing survives, like the other reads.
    expect(ctx.tools.get('github_pr_list')).toBeDefined()
  })

  it('names the event and its consequence in the approval reason for a verdict', () => {
    const reason = reviewSubmitApprovalReason({
      repo: 'octo/hello-world',
      number: 5,
      event: 'APPROVE',
      body: 'Ship it\nmore detail',
      comments: [{ path: 'a.ts', line: 1, body: 'x' }],
    })
    expect(reason).toContain('APPROVE review on octo/hello-world#5 under YOUR GitHub account')
    expect(reason).toContain('1 inline comment(s)')
    expect(reason).toContain('changes whether the PR is blocked')
    expect(reason).toContain('Ship it')
  })

  it('keeps the plain-comment reason free of verdict language', () => {
    const reason = reviewSubmitApprovalReason({ repo: 'octo/hello-world', number: 5, event: 'COMMENT' })
    expect(reason).toBe('Submit a review comment on octo/hello-world#5 (no inline comments)')
  })

  it('stays defensive against wrongly-typed approval arguments', () => {
    expect(reviewSubmitApprovalReason(null)).toContain('?#?')
    expect(reviewSubmitApprovalReason({ comments: 'not an array' })).toContain('no inline comments')
    expect(prUpdateApprovalReason({})).toContain('no fields')
    expect(prAssignApprovalReason({})).toContain('nothing to change')
  })

  it('summarizes update and assign reasons from their arguments', () => {
    expect(prUpdateApprovalReason({ repo: 'o/r', number: 5, title: 'New title', body: 'x', state: 'closed' }))
      .toBe('Update GitHub PR o/r#5: title → "New title", body, state → "closed"')
    expect(prAssignApprovalReason({ repo: 'o/r', number: 5, reviewers: ['a', 'b'], labels: ['bug'], label_mode: 'set' }))
      .toBe('Update GitHub PR o/r#5: request review from 2 user(s), replace 1 label(s)')
    expect(prAssignApprovalReason({ repo: 'o/r', number: 5, labels: ['bug'] }))
      .toBe('Update GitHub PR o/r#5: add 1 label(s)')
  })
})

describe('review-write tools (M10)', () => {
  it('submits a comment review with inline comments after approval', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_pr_review_submit', {
      repo: 'octo/hello-world',
      number: 5,
      event: 'COMMENT',
      body: 'notes',
      comments: [{ path: 'src/a.ts', line: 42, body: 'this leaks', side: 'right' }],
    }, { withAgent: true })
    expect(ok(result)).toBe(
      'Submitted a COMMENT review on octo/hello-world#5 (1 inline comment(s)); it now reads as commented.'
      + '\nhttps://x/pull/5#pullrequestreview-11',
    )
    expect(suite.approval!.requests[0]!.reason).toContain('Submit a review comment')
  })

  it('submits a verdict when the switch is on, and reports the resulting state', async () => {
    const suite = await mountSuite({ reviewVerdicts: true }, { approval: true })
    expect(ok(await suite.run('github_pr_review_submit', { repo: 'octo/hello-world', number: 5, event: 'APPROVE' }, { withAgent: true })))
      .toContain('it now reads as approved')
    expect(suite.approval!.requests[0]!.reason).toContain('under YOUR GitHub account')
  })

  it('turns a denied submission into an answer, not an exception', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['rejected']
    const result = await suite.run('github_pr_review_submit', { repo: 'octo/hello-world', number: 5, event: 'COMMENT' }, { withAgent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).not.toBe('')
  })

  it('updates a pull request and renders the resulting shape', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_pr_update', {
      repo: 'octo/hello-world',
      number: 5,
      title: 'Renamed',
      body: 'new body',
      base: 'develop',
      state: 'closed',
    }, { withAgent: true })
    expect(ok(result)).toBe('Updated octo/hello-world#5: "Renamed" [closed] → develop\nhttps://x/pull/5')
  })

  it('sends only the field it was given, and renders a PR that has no URL', async () => {
    const requests: unknown[] = []
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        updatePullRequest: request => {
          requests.push(request)
          return Promise.resolve({
            ref: { repo: request.item.repo, number: request.item.number },
            title: 'Renamed',
            state: 'open' as const,
            baseRef: 'main',
            headRef: 'feat/x',
          })
        },
      },
    })
    const result = await suite.run('github_pr_update', { repo: 'octo/hello-world', number: 5, title: 'Renamed' }, { withAgent: true })
    expect(requests[0]).toEqual({ item: { repo: { owner: 'octo', repo: 'hello-world' }, number: 5 }, title: 'Renamed' })
    expect(ok(result)).toBe('Updated octo/hello-world#5: "Renamed" [open] → main')

    // ...and the same holds for a title-less update.
    await suite.run('github_pr_update', { repo: 'octo/hello-world', number: 5, state: 'closed' }, { withAgent: true })
    expect(requests[1]).toEqual({ item: { repo: { owner: 'octo', repo: 'hello-world' }, number: 5 }, state: 'closed' })
  })

  it('renders a submitted review that came back without a URL', async () => {
    const suite = await mountSuite({}, {
      approval: true,
      provider: { submitReview: () => Promise.resolve({ id: 11, state: 'commented' as const }) },
    })
    // The comment carries no explicit side — the seam and GitHub both default it.
    expect(ok(await suite.run('github_pr_review_submit', {
      repo: 'octo/hello-world',
      number: 5,
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 3, body: 'no side given' }],
    }, { withAgent: true })))
      .toBe('Submitted a COMMENT review on octo/hello-world#5 (1 inline comment(s)); it now reads as commented.')
  })

  it('assigns reviewers and labels, and reports both', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_pr_assign', {
      repo: 'octo/hello-world',
      number: 5,
      reviewers: ['alice'],
      labels: ['bug', 'urgent'],
      label_mode: 'add',
    }, { withAgent: true })
    expect(ok(result)).toBe('Updated octo/hello-world#5.\nReview requested from: alice\nLabels now: bug, urgent')
  })

  it('handles each half of an assignment on its own', async () => {
    const suite = await mountSuite({}, { approval: true })
    expect(ok(await suite.run('github_pr_assign', { repo: 'octo/hello-world', number: 5, reviewers: ['alice'] }, { withAgent: true })))
      .toBe('Updated octo/hello-world#5.\nReview requested from: alice')
    // No label_mode given: the seam default (add) applies.
    expect(ok(await suite.run('github_pr_assign', { repo: 'octo/hello-world', number: 5, labels: ['bug'] }, { withAgent: true })))
      .toBe('Updated octo/hello-world#5.\nLabels now: bug')
  })

  it('skips the calls it has nothing to do', async () => {
    const seen: string[] = []
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        requestReviewers: () => { seen.push('reviewers'); return Promise.resolve() },
        setLabels: request => { seen.push('labels'); return Promise.resolve([...request.labels]) },
      },
    })
    expect(ok(await suite.run('github_pr_assign', { repo: 'octo/hello-world', number: 5, reviewers: [], labels: [] }, { withAgent: true })))
      .toBe('Updated octo/hello-world#5.')
    expect(seen).toEqual([])
  })

  it('presents each pending review-write as an edit', async () => {
    const { ctx } = await mountSuite()
    expect(ctx.tools.get('github_pr_review_submit')!.presentCall!({ repo: 'o/r', number: 5, event: 'COMMENT' }))
      .toMatchObject({ title: 'Submit COMMENT review on GitHub PR o/r#5', kind: 'edit' })
    expect(ctx.tools.get('github_pr_update')!.presentCall!({ repo: 'o/r', number: 5 }))
      .toMatchObject({ title: 'Update GitHub PR o/r#5', kind: 'edit' })
    expect(ctx.tools.get('github_pr_assign')!.presentCall!({ repo: 'o/r', number: 5 }))
      .toMatchObject({ title: 'Assign on GitHub PR o/r#5', kind: 'edit' })
  })

  it('rejects a non-positive PR number in every review-write tool', async () => {
    const suite = await mountSuite({}, { approval: true })
    for (const name of ['github_pr_review_submit', 'github_pr_update', 'github_pr_assign']) {
      const result = await suite.run(name, { repo: 'octo/hello-world', number: 0, event: 'COMMENT' }, { withAgent: true })
      expect(result.isError).toBe(true)
    }
  })
})

describe('github_pr_list (M10)', () => {
  it('lists pull requests as lean scannable rows', async () => {
    const suite = await mountSuite()
    expect(ok(await suite.run('github_pr_list', { repo: 'octo/hello-world' }))).toBe([
      'Pull requests in octo/hello-world (2):',
      '- #5 [open] Add feature · feat/x → main · octocat',
      '- #6 [open (draft)] WIP · feat/y → main',
    ].join('\n'))
  })

  it('passes filters and the capped bound to the seam', async () => {
    const requests: unknown[] = []
    const suite = await mountSuite({ searchMaxResults: 3 }, {
      provider: {
        listPullRequests: request => { requests.push(request); return Promise.resolve([]) },
      },
    })
    const result = await suite.run('github_pr_list', {
      repo: 'octo/hello-world',
      state: 'all',
      head: 'feat/x',
      base: 'main',
      max_results: 99,
    })
    expect(requests[0]).toMatchObject({ state: 'all', head: 'feat/x', base: 'main', maxResults: 3 })
    expect(ok(result)).toBe('No pull requests in octo/hello-world for that filter.')
  })

  it('is a read tool: present, concurrency-safe, and alive under write: false', async () => {
    const { ctx } = await mountSuite({ write: false })
    const definition = ctx.tools.get('github_pr_list')!
    expect(definition.isConcurrencySafe!({ repo: 'o/r' })).toBe(true)
    expect(definition.presentCall!({ repo: 'o/r' })).toMatchObject({ title: 'List GitHub pull requests in o/r', kind: 'read' })
  })

  it('rejects a non-positive max_results', async () => {
    const suite = await mountSuite()
    expect((await suite.run('github_pr_list', { repo: 'octo/hello-world', max_results: 0 })).isError).toBe(true)
  })
})

// —— pure formatters ——————————————————————————————————————————————————————————

describe('formatters', () => {
  it('formats empty structures', () => {
    expect(formatDiff({ files: [], truncated: false })).toBe('No changed files.')
    expect(formatChecks([])).toBe('No check runs reported.')
    expect(formatComments([], 0)).toBe('No comments.')
    expect(formatCiFailures({ failures: [], truncated: false })).toBe('No failing check runs.')
    expect(formatReviews({ items: [], comments: [], totalComments: 0 })).toBe('No submitted reviews.\n\nNo line comments.')
  })

  it('drops an all-whitespace review body rather than indenting nothing', () => {
    expect(formatReviews({ items: [{ state: 'approved', author: 'alice', body: '  ' }], comments: [], totalComments: 0 }))
      .toBe('Reviews (1):\n- alice — approved\n\nNo line comments.')
  })

  it('renders an annotation without a line or title', () => {
    expect(formatCiFailures({
      failures: [{ name: 'lint', annotations: [{ path: 'src/a.ts', level: 'warning', message: 'unused' }] }],
      truncated: false,
    })).toBe('CI failures (1):\n- lint: failure\n  ! src/a.ts [warning] unused')
  })

  it('omits the tail marker for a log that fit its budget whole', () => {
    expect(formatCiFailures({
      failures: [{ name: 'test', conclusion: 'failure', annotations: [], log: { text: 'exit 1', truncated: false } }],
      truncated: false,
    })).toBe('CI failures (1):\n- test: failure\n  Log:\n```\nexit 1\n```')
  })

  it('summarizes failing and passing check sets', () => {
    expect(formatChecks([
      { name: 'ci', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ])).toBe('Checks (1 failing):\n- ci: failure\n- lint: success')
    expect(formatChecks([
      { name: 'ci', status: 'completed', conclusion: 'success' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
    ])).toBe('Checks (all passing):\n- ci: success\n- docs: skipped')
  })

  it('falls back when a pr_read value carries no part payload', () => {
    expect(renderPrRead({ part: 'diff' })).toBe('No data for part "diff".')
  })

  it('previews bodies: first line, capped, blank-safe', () => {
    expect(preview(undefined)).toBe('')
    expect(preview('   ')).toBe('')
    expect(preview('short body')).toBe('short body')
    expect(preview('first line\nsecond line')).toBe('first line')
    expect(preview('x'.repeat(130))).toBe(`${'x'.repeat(120)}…`)
  })

  it('parses repo inputs strictly', () => {
    expect(parseRepoInput(' octo/hello-world ')).toEqual({ owner: 'octo', repo: 'hello-world' })
    for (const bad of ['a', 'a/b/c', 'a b/c', '/b', 'a/']) {
      expect(() => parseRepoInput(bad)).toThrow(/repo must be "owner\/repo"/)
    }
  })
})

// —— write tools + approval (M4) ——————————————————————————————————————————————

describe('write tools and the approval gate', () => {
  it('denies a write when no approval seam is mounted, carrying the reason', async () => {
    const suite = await mountSuite()
    const result = await suite.run('github_issue_create', { repo: 'octo/hello-world', title: 'T', body: 'first line\nrest' }, { withAgent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: Create GitHub issue in octo/hello-world: "T" — first line')
  })

  it('runs the write after the user approves, and shows the panel the target', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['allowed-once']
    const result = await suite.run('github_issue_create', { repo: 'octo/hello-world', title: 'T' }, { withAgent: true })
    expect(ok(result)).toBe('Created issue octo/hello-world#9: T\nhttps://github.com/octo/hello-world/issues/9')
    expect(suite.approval!.requests).toEqual([
      { toolName: 'github_issue_create', reason: 'Create GitHub issue in octo/hello-world: "T"' },
    ])
  })

  it('returns a model-visible refusal when the user rejects (no exception)', async () => {
    const created: unknown[] = []
    const suite = await mountSuite({}, {
      approval: true,
      provider: { createIssue: request => { created.push(request); return Promise.reject(new Error('unreachable')) } },
    })
    suite.approval!.outcomes = ['rejected']
    const result = await suite.run('github_issue_create', { repo: 'octo/hello-world', title: 'T' }, { withAgent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/the user rejected tool "github_issue_create"/)
    expect(created).toHaveLength(0)
  })

  it('denies when approval times out or is cancelled', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['cancelled']
    const result = await suite.run('github_issue_comment', { repo: 'octo/hello-world', number: 7, body: 'hi' }, { withAgent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/approval for tool "github_issue_comment" was cancelled/)
  })

  it('denies an agent-less write even with an approval seam mounted', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_pr_create', { repo: 'o/r', title: 'T', head: 'h', base: 'b' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/no agent to route it through/)
  })

  it('lets read tools through the gate untouched', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['rejected']
    const result = await suite.run('github_search', { kind: 'issues', query: 'q' })
    expect(result.isError).toBe(false)
    expect(suite.approval!.requests).toHaveLength(0)
  })

  it('describes each write to the approval panel, defensively on malformed args', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['rejected', 'rejected', 'rejected']
    await suite.run('github_issue_comment', { repo: 'octo/hello-world', number: 7, body: 'looks fine to me' }, { withAgent: true })
    await suite.run('github_pr_create', { repo: 'octo/hello-world', title: 'Ship', head: 'feat/x', base: 'main' }, { withAgent: true })
    await suite.run('github_pr_create', 'garbage', { withAgent: true })
    expect(suite.approval!.requests.map(request => request.reason)).toEqual([
      'Comment on GitHub octo/hello-world#7: looks fine to me',
      'Create GitHub pull request in octo/hello-world (feat/x → main): "Ship"',
      'Create GitHub pull request in ? (? → ?): "?"',
    ])
  })

  it('posts a comment after approval', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_issue_comment', { repo: 'octo/hello-world', number: 7, body: 'hi' }, { withAgent: true })
    expect(ok(result)).toBe('Posted comment on octo/hello-world#7\nhttps://x/comment/5')
  })

  it('creates a PR and presents the idempotent re-run as already open (M4 DoD)', async () => {
    let calls = 0
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        createPullRequest: request => {
          calls += 1
          return Promise.resolve({
            pullRequest: {
              ref: { repo: request.repo, number: 5, url: 'https://x/pull/5' },
              title: request.title,
              state: 'open' as const,
              baseRef: request.base,
              headRef: request.head,
            },
            created: calls === 1,
          })
        },
      },
    })
    const args = { repo: 'octo/hello-world', title: 'Ship', head: 'feat/x', base: 'main' }
    const first = await suite.run('github_pr_create', args, { withAgent: true })
    expect(ok(first)).toBe('Created pull request octo/hello-world#5: Ship\nhttps://x/pull/5')
    const second = await suite.run('github_pr_create', args, { withAgent: true })
    expect(ok(second)).toBe([
      'An open pull request for feat/x → main already exists — returned it instead of creating a duplicate.',
      'octo/hello-world#5: Ship',
      'https://x/pull/5',
    ].join('\n'))
  })

  it('presents PR creation outcomes from meta', async () => {
    const { ctx } = await mountSuite()
    const definition = ctx.tools.get('github_pr_create')!
    const args = { repo: 'o/r', title: 'T', head: 'h', base: 'b' }
    expect(definition.presentCall!(args)).toMatchObject({ kind: 'edit', title: 'Create GitHub PR in o/r: h → b' })
    expect(definition.presentResult!(args, { content: [], isError: false, meta: { number: 5, created: true } }))
      .toEqual({ card: 'generic', title: 'Created PR #5' })
    expect(definition.presentResult!(args, { content: [], isError: false, meta: { number: 5, created: false } }))
      .toEqual({ card: 'generic', title: 'PR #5 already open' })
    expect(presentPrCreateResult({ content: [], isError: true })).toBeUndefined()
    expect(presentPrCreateResult({ content: [], isError: false })).toBeUndefined()
    expect(presentPrCreateResult({ content: [], isError: false, meta: { number: 'x', created: true } as never })).toBeUndefined()
  })

  it('presents the pending issue and comment writes', async () => {
    const { ctx } = await mountSuite()
    expect(ctx.tools.get('github_issue_create')!.presentCall!({ repo: 'o/r', title: 'T' }))
      .toMatchObject({ kind: 'edit', title: 'Create GitHub issue in o/r: T' })
    expect(ctx.tools.get('github_issue_comment')!.presentCall!({ repo: 'o/r', number: 7, body: 'hi' }))
      .toMatchObject({ kind: 'edit', title: 'Comment on GitHub o/r#7' })
  })

  it('creates a full-fat issue without a returned URL', async () => {
    const bodies: unknown[] = []
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        createIssue: request => {
          bodies.push(request)
          return Promise.resolve({ ref: { repo: request.repo, number: 9 }, title: request.title, state: 'open' as const })
        },
      },
    })
    const result = await suite.run('github_issue_create', { repo: 'octo/hello-world', title: 'T', body: 'B', labels: ['bug'] }, { withAgent: true })
    expect(ok(result)).toBe('Created issue octo/hello-world#9: T')
    expect(bodies[0]).toMatchObject({ title: 'T', body: 'B', labels: ['bug'] })
  })

  it('posts a comment whose provider returns no URL', async () => {
    const suite = await mountSuite({}, {
      approval: true,
      provider: { createComment: () => Promise.resolve({ id: 5, body: 'done' }) },
    })
    const result = await suite.run('github_issue_comment', { repo: 'octo/hello-world', number: 7, body: 'hi' }, { withAgent: true })
    expect(ok(result)).toBe('Posted comment on octo/hello-world#7')
  })

  it('passes body and draft through PR creation and renders without a URL', async () => {
    const requests: unknown[] = []
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        createPullRequest: request => {
          requests.push(request)
          return Promise.resolve({
            pullRequest: {
              ref: { repo: request.repo, number: 5 },
              title: request.title,
              state: 'open' as const,
              baseRef: request.base,
              headRef: request.head,
            },
            created: true,
          })
        },
      },
    })
    const result = await suite.run('github_pr_create', { repo: 'o/r', title: 'T', head: 'h', base: 'b', body: 'D', draft: true }, { withAgent: true })
    expect(ok(result)).toBe('Created pull request o/r#5: T')
    expect(requests[0]).toMatchObject({ body: 'D', draft: true })
  })

  it('keeps approval reasons defensive against wrongly-typed fields', async () => {
    const suite = await mountSuite({}, { approval: true })
    suite.approval!.outcomes = ['rejected', 'rejected', 'rejected', 'rejected']
    await suite.run('github_issue_comment', { repo: 5, number: 'x', body: 7 }, { withAgent: true })
    await suite.run('github_issue_comment', null, { withAgent: true })
    await suite.run('github_issue_comment', 'garbage', { withAgent: true })
    await suite.run('github_issue_create', {}, { withAgent: true })
    expect(suite.approval!.requests.map(request => request.reason)).toEqual([
      'Comment on GitHub ?#?: ',
      'Comment on GitHub ?#?: ',
      'Comment on GitHub ?#?: ',
      'Create GitHub issue in ?: "?"',
    ])
  })

  it('renders an already-open PR without a URL', async () => {
    const suite = await mountSuite({}, {
      approval: true,
      provider: {
        createPullRequest: request => Promise.resolve({
          pullRequest: {
            ref: { repo: request.repo, number: 5 },
            title: request.title,
            state: 'open' as const,
            baseRef: request.base,
            headRef: request.head,
          },
          created: false,
        }),
      },
    })
    const result = await suite.run('github_pr_create', { repo: 'o/r', title: 'T', head: 'h', base: 'b' }, { withAgent: true })
    expect(ok(result)).toBe('An open pull request for h → b already exists — returned it instead of creating a duplicate.\no/r#5: T')
  })

  it('declares read tools parallel-safe', async () => {
    const { ctx } = await mountSuite()
    expect(ctx.tools.get('github_search')!.isConcurrencySafe!({ kind: 'issues', query: 'q' })).toBe(true)
    expect(ctx.tools.get('github_issue_read')!.isConcurrencySafe!({ repo: 'o/r', number: 1 })).toBe(true)
    expect(ctx.tools.get('github_pr_read')!.isConcurrencySafe!({ repo: 'o/r', number: 1 })).toBe(true)
  })

  it('rejects a bad repo argument in a write after approval', async () => {
    const suite = await mountSuite({}, { approval: true })
    const result = await suite.run('github_issue_create', { repo: 'nope', title: 'T' }, { withAgent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/repo must be "owner\/repo"/)
  })
})

// —— invariant companion ——————————————————————————————————————————————————————

describe('dsh-tool-github invariant companion', () => {
  it('registers with the invariant service and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(toolInvariant.name).toBe('tool-github-invariant')
    expect(toolInvariant.inject).toEqual(['invariants'])
    const dispose = await toolInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
