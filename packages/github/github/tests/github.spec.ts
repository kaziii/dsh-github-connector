import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import GitHubRuntime, {
  buildReviewBrief,
  changedLines,
  classifyFile,
  GitHubError,
  routeDimensions,
  type GitHubCheckFailuresResult,
  type GitHubCheckRun,
  type GitHubComment,
  type GitHubDiff,
  type GitHubDiffFile,
  type GitHubIssue,
  type GitHubItemRef,
  type GitHubProvider,
  type GitHubPullRequest,
  type GitHubRepoRef,
  type GitHubReview,
  type GitHubReviewComment,
  type GitHubSearchResult,
} from 'dsh-github'
import * as githubInvariant from 'dsh-github/invariant'

const available = true
const unavailable = false

function repo(overrides: Partial<GitHubRepoRef> = {}): GitHubRepoRef {
  return { owner: 'octo', repo: 'hello-world', ...overrides }
}

function item(number = 1, repoRef: GitHubRepoRef = repo()): GitHubItemRef {
  return { repo: repoRef, number }
}

function issue(ref: GitHubItemRef, marker = 'issue'): GitHubIssue {
  return { ref, title: marker, state: 'open' }
}

function pullRequest(ref: GitHubItemRef, marker = 'pr'): GitHubPullRequest {
  return { ref, title: marker, state: 'open', baseRef: 'main', headRef: 'feat/x' }
}

function comment(id: number): GitHubComment {
  return { id, body: `comment ${id}` }
}

function diffFile(path: string, patch?: string): GitHubDiffFile {
  return { path, status: 'modified', additions: 1, deletions: 0, ...patch === undefined ? {} : { patch } }
}

function searchResult(overrides: Partial<GitHubSearchResult> = {}): GitHubSearchResult {
  return { items: [], truncated: false, ...overrides }
}

function review(body: string): GitHubReview {
  return { id: 1, state: 'commented', body }
}

function reviewComment(body: string): GitHubReviewComment {
  return { id: 1, path: 'src/a.ts', body, side: 'right', line: 42 }
}

function failedRun(name = 'build'): GitHubCheckRun {
  return { name, status: 'completed', conclusion: 'failure' }
}

/** A failure result carrying one log, for budget tests. */
function failuresWithLog(text: string, truncated = false): GitHubCheckFailuresResult {
  return { failures: [{ run: failedRun(), annotations: [], log: { text, truncated } }], truncated: false }
}

/** A scripted provider for contract tests; override individual operations per test. */
function makeProvider(id: string, usable: boolean, overrides: Partial<GitHubProvider> = {}): GitHubProvider {
  return {
    id,
    available: () => usable,
    search: () => Promise.resolve(searchResult({ items: [{ title: id, url: `https://github.com/${id}` }] })),
    getIssue: ref => Promise.resolve(issue(ref, `issue:${id}`)),
    getPullRequest: ref => Promise.resolve(pullRequest(ref, `pr:${id}`)),
    getComments: () => Promise.resolve([comment(1)]),
    getDiff: () => Promise.resolve({ files: [diffFile('a.ts', '+a')], truncated: false }),
    getChecks: () => Promise.resolve({ runs: [{ name: 'ci', status: 'completed' as const, conclusion: 'success' as const }] }),
    getReviews: () => Promise.resolve([review(`review:${id}`)]),
    getReviewComments: () => Promise.resolve([reviewComment(`review-comment:${id}`)]),
    getCheckFailures: () => Promise.resolve({ failures: [], truncated: false }),
    getMergeability: () => Promise.resolve({ mergeable: true, state: 'clean' as const, blockedBy: [] }),
    listPullRequests: request => Promise.resolve([pullRequest({ repo: request.repo, number: 1 }, `listed:${id}`)]),
    submitReview: request => Promise.resolve({ ...review(`submitted:${id}`), state: request.event === 'APPROVE' ? 'approved' as const : 'commented' as const }),
    updatePullRequest: request => Promise.resolve(pullRequest(request.item, `updated:${id}`)),
    requestReviewers: () => Promise.resolve(),
    setLabels: request => Promise.resolve([...request.labels]),
    createIssue: request => Promise.resolve(issue({ repo: request.repo, number: 7 }, `created:${id}`)),
    createComment: () => Promise.resolve(comment(9)),
    createPullRequest: request => Promise.resolve({
      pullRequest: pullRequest({ repo: request.repo, number: 5 }, `created-pr:${id}`),
      created: true,
    }),
    ...overrides,
  }
}

/** Mount a GitHubRuntime on a fresh root context with the given config. */
async function mountGitHub(config: ConstructorParameters<typeof GitHubRuntime>[1] = {}): Promise<{ ctx: Context; github: GitHubRuntime }> {
  const ctx = new Context()
  await ctx.plugin(GitHubRuntime, config)
  return { ctx, github: ctx.github }
}

afterEach(() => {
  delete process.env.DSH_GITHUB_PROVIDER
})

describe('GitHubRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { github } = await mountGitHub()

    const dispose = github.registerProvider(makeProvider('rest', available))
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:rest' })

    dispose()
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws GITHUB_PROVIDER_DUPLICATE on a duplicate id', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    expect(() => github.registerProvider(makeProvider('rest', available)))
      .toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_DUPLICATE' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, github } = await mountGitHub()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.github.registerProvider(makeProvider('rest', available))
    }, { inject: ['github'] }))
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:rest' })
    await fiber.dispose()
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
  })
})

describe('GitHubRuntime execution resolution', () => {
  it('throws GITHUB_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { github } = await mountGitHub()
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws GITHUB_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', unavailable))
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws GITHUB_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { github } = await mountGitHub({ provider: 'enterprise' })
    github.registerProvider(makeProvider('rest', available))
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { github } = await mountGitHub({ provider: 'rest' })
    github.registerProvider(makeProvider('rest', unavailable))
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws GITHUB_PROVIDER_AMBIGUOUS rather than picking by order when two usable providers are registered', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    github.registerProvider(makeProvider('enterprise', available))
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { github } = await mountGitHub({ provider: 'enterprise' })
    github.registerProvider(makeProvider('rest', available))
    github.registerProvider(makeProvider('enterprise', available))
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:enterprise' })
  })

  it('reads the provider id from $DSH_GITHUB_PROVIDER when config omits it', async () => {
    process.env.DSH_GITHUB_PROVIDER = 'enterprise'
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    github.registerProvider(makeProvider('enterprise', available))
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:enterprise' })
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    github.registerProvider(makeProvider('enterprise', unavailable))
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:rest' })
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountGitHub()
    a.github.registerProvider(makeProvider('rest', unavailable))
    a.github.registerProvider(makeProvider('enterprise', available))
    await expect(a.github.getIssue(item())).resolves.toMatchObject({ title: 'issue:enterprise' })

    const b = await mountGitHub()
    b.github.registerProvider(makeProvider('enterprise', available))
    b.github.registerProvider(makeProvider('rest', unavailable))
    await expect(b.github.getIssue(item())).resolves.toMatchObject({ title: 'issue:enterprise' })
  })

  it('resolves the provider on every call, so a provider that becomes usable is picked up without restart', async () => {
    const { github } = await mountGitHub()
    let usable = false
    github.registerProvider(makeProvider('rest', available, { available: () => usable }))
    await expect(github.getIssue(item())).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
    usable = true
    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:rest' })
  })
})

describe('GitHubRuntime REAL composition (fake provider walks every operation)', () => {
  it('walks search, reads, and writes through one registered provider', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))

    const search = await github.search({ kind: 'issues', query: 'is:open' })
    expect(search.items).toEqual([{ title: 'rest', url: 'https://github.com/rest' }])

    await expect(github.getIssue(item())).resolves.toMatchObject({ title: 'issue:rest' })
    await expect(github.getPullRequest(item())).resolves.toMatchObject({ title: 'pr:rest', baseRef: 'main' })
    await expect(github.getComments(item())).resolves.toEqual([comment(1)])
    await expect(github.getDiff(item())).resolves.toEqual({ files: [diffFile('a.ts', '+a')], truncated: false })
    await expect(github.getChecks(item())).resolves.toEqual({ runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
    await expect(github.getReviews(item())).resolves.toEqual([review('review:rest')])
    await expect(github.getReviewComments(item())).resolves.toEqual([reviewComment('review-comment:rest')])
    await expect(github.getCheckFailures(item())).resolves.toEqual({ failures: [], truncated: false })

    await expect(github.createIssue({ repo: repo(), title: 't' })).resolves.toMatchObject({ title: 'created:rest' })
    await expect(github.createComment({ item: item(), body: 'b' })).resolves.toEqual(comment(9))
    const created = await github.createPullRequest({ repo: repo(), title: 't', head: 'feat/x', base: 'main' })
    expect(created.created).toBe(true)
    expect(created.pullRequest.title).toBe('created-pr:rest')
  })

  it('propagates the abort signal to the provider', async () => {
    const { github } = await mountGitHub()
    const seen: (AbortSignal | undefined)[] = []
    github.registerProvider(makeProvider('rest', available, {
      getIssue: (ref, signal) => { seen.push(signal); return Promise.resolve(issue(ref)) },
    }))
    const controller = new AbortController()
    await github.getIssue(item(), controller.signal)
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('GitHubRuntime ref and budget validation', () => {
  it.each([
    ['blank owner', repo({ owner: '  ' })],
    ['blank repo', repo({ repo: '' })],
  ])('rejects a repo ref with a %s as GITHUB_VALIDATION', async (_label, bad) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.createIssue({ repo: bad, title: 't' })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
  ])('rejects a %s item number as GITHUB_VALIDATION', async (_label, number) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.getIssue(item(number))).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('validates the item ref of comment creation', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.createComment({ item: item(0), body: 'b' })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('validates the repo ref of pull request creation', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.createPullRequest({ repo: repo({ owner: '' }), title: 't', head: 'h', base: 'b' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it.each([
    ['zero maxFiles', { maxFiles: 0 }],
    ['fractional maxPatchChars', { maxPatchChars: 2.5 }],
  ])('rejects a diff budget with %s as GITHUB_VALIDATION', async (_label, budget) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.getDiff(item(), budget)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it.each([
    ['zero maxLogLines', { maxLogLines: 0 }],
    ['fractional maxLogChars', { maxLogChars: 2.5 }],
  ])('rejects a log budget with %s as GITHUB_VALIDATION', async (_label, budget) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.getCheckFailures(item(), budget)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it.each([
    ['getReviews', (github: GitHubRuntime) => github.getReviews(item(0))],
    ['getReviewComments', (github: GitHubRuntime) => github.getReviewComments(item(0))],
    ['getCheckFailures', (github: GitHubRuntime) => github.getCheckFailures(item(0))],
  ])('validates the item ref of %s', async (_label, call) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(call(github)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('rejects a non-positive-integer search maxResults as GITHUB_VALIDATION', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.search({ kind: 'code', query: 'q', maxResults: -1 })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('validates before resolving the provider, so bad input never reports provider absence', async () => {
    const { github } = await mountGitHub()
    await expect(github.getIssue(item(0))).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })
})

describe('review dimension routing (ADR-0013, deterministic half)', () => {
  function file(path: string, patch?: string): GitHubDiffFile {
    return { path, status: 'modified', additions: 1, deletions: 0, ...patch === undefined ? {} : { patch } }
  }

  /** Which dimensions fired, sorted — routing owns the SET, `buildReviewBrief` owns the order. */
  const applied = (files: readonly GitHubDiffFile[]): string[] => [...routeDimensions(files).keys()].sort()

  it.each([
    ['a test by suffix', 'src/a.test.ts', 'test'],
    ['a test by directory', 'tests/helpers.ts', 'test'],
    ['a __tests__ file', 'src/__tests__/a.ts', 'test'],
    ['documentation', 'docs/design.md', 'docs'],
    ['a plain readme', 'README.md', 'docs'],
    ['a declaration file', 'src/api.d.ts', 'types'],
    ['a types module', 'src/types.ts', 'types'],
    ['ordinary source', 'src/a.ts', 'code'],
    ['another language', 'scripts/run.py', 'code'],
    ['a binary asset', 'assets/logo.png', 'asset'],
  ])('classifies %s', (_label, path, kind) => {
    expect(classifyFile(path)).toBe(kind)
  })

  it('lets use win over content: a types file under tests/ is a test', () => {
    expect(classifyFile('tests/types.ts')).toBe('test')
  })

  it('reads only added and removed lines, never the surrounding context', () => {
    const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' const kept = 1', '-const old = 2', '+const fresh = 3'].join('\n')
    expect(changedLines(patch)).toEqual(['const old = 2', 'const fresh = 3'])
    expect(changedLines(undefined)).toEqual([])
  })

  it('routes a docs-only change to comments alone', () => {
    expect(applied([file('docs/design.md', '+prose')])).toEqual(['comments'])
  })

  it('asks for tests when source moved but no test file did', () => {
    const routes = routeDimensions([file('src/a.ts', '+const a = 1')])
    expect([...routes.keys()].sort()).toEqual(['correctness', 'simplification', 'tests'])
    expect(routes.get('tests')!.reason).toBe('source changed with no test file touched')
  })

  it('points the tests dimension at both the tests and the source they cover', () => {
    const routes = routeDimensions([file('src/a.ts', '+const a = 1'), file('src/a.test.ts', '+expect(a)')])
    expect(routes.get('tests')).toEqual({
      reason: '1 test file(s) changed',
      paths: ['src/a.test.ts', 'src/a.ts'],
    })
  })

  it('adds error-handling, types, and comments from the changed lines themselves', () => {
    const routes = routeDimensions([
      file('src/a.ts', '+try { go() } catch (error) { ignore() }'),
      file('src/b.ts', '+interface Shape { x: number }'),
      file('src/c.ts', '+// explain the why'),
    ])
    expect([...routes.keys()].sort()).toEqual(['comments', 'correctness', 'error-handling', 'simplification', 'tests', 'types'])
    // ...and the brief presents them in a fixed order regardless of routing order.
    expect(buildReviewBrief(pullRequest(item()), { files: [file('src/a.ts', '+try {} catch (e) {}')], truncated: false })
      .dimensions.map(d => d.dimension)).toEqual(['correctness', 'tests', 'error-handling', 'simplification'])
    expect(routes.get('error-handling')!.paths).toEqual(['src/a.ts'])
    expect(routes.get('types')!.paths).toEqual(['src/b.ts'])
    expect(routes.get('comments')!.paths).toEqual(['src/c.ts'])
  })

  it('ignores keywords that only appear in a patch\'s context lines', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' try { existing() } catch (e) {}', '+const unrelated = 1'].join('\n')
    expect(applied([file('src/a.ts', patch)])).not.toContain('error-handling')
  })

  it('routes a declaration file to types even with no patch to inspect', () => {
    expect(applied([file('src/api.d.ts')])).toContain('types')
  })

  it('routes nothing when only assets changed', () => {
    expect(applied([file('assets/logo.png')])).toEqual([])
    expect(applied([])).toEqual([])
  })

  it('carries the diff exactly once and lets dimensions reference its paths', () => {
    const diff: GitHubDiff = { files: [diffFile('src/a.ts', '+const a = 1')], truncated: false }
    const brief = buildReviewBrief(pullRequest(item()), diff)
    // Identity, not a copy: six dimensions must cost one diff.
    expect(brief.diff).toBe(diff)
    for (const dimension of brief.dimensions) {
      for (const path of dimension.paths) {
        expect(diff.files.map(f => f.path)).toContain(path)
      }
    }
  })

  it('honors a caller restriction and keeps presentation order', () => {
    const diff: GitHubDiff = { files: [diffFile('src/a.ts', '+interface A {}')], truncated: false }
    const brief = buildReviewBrief(pullRequest(item()), diff, { dimensions: ['types', 'correctness'] })
    expect(brief.dimensions.map(d => d.dimension)).toEqual(['correctness', 'types'])
  })

  it('reports a truncated diff as a knowingly partial review', () => {
    const diff: GitHubDiff = { files: [diffFile('src/a.ts', '+a')], truncated: true }
    expect(buildReviewBrief(pullRequest(item()), diff).truncated).toBe(true)
  })

  it('ships a severity scale and an output contract with every brief', () => {
    const brief = buildReviewBrief(pullRequest(item()), { files: [], truncated: false })
    expect(brief.severityScale.map(entry => entry.level)).toEqual(['blocker', 'major', 'minor', 'nit'])
    expect(brief.outputContract.length).toBeGreaterThan(0)
    expect(brief.dimensions).toEqual([])
  })
})

describe('GitHubRuntime buildReviewBrief operation', () => {
  it('passes the caller budgets to the diff read and assembles the brief', async () => {
    const budgets: unknown[] = []
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available, {
      getDiff: (_item, request) => {
        budgets.push(request)
        return Promise.resolve({ files: [diffFile('src/a.ts', '+const a = 1')], truncated: false })
      },
    }))
    const brief = await github.buildReviewBrief(item(), { maxFiles: 9, maxPatchChars: 90 })
    expect(budgets[0]).toEqual({ maxFiles: 9, maxPatchChars: 90 })
    expect(brief.pullRequest.title).toBe('pr:rest')
    expect(brief.dimensions.map(d => d.dimension)).toEqual(['correctness', 'tests', 'simplification'])
  })

  it('validates the item ref before touching a provider', async () => {
    const { github } = await mountGitHub()
    await expect(github.buildReviewBrief(item(0))).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('defaults to unrestricted budgets and dimensions', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    const brief = await github.buildReviewBrief(item())
    expect(brief.diff).toEqual({ files: [diffFile('a.ts', '+a')], truncated: false })
  })
})

describe('GitHubRuntime review-write and lifecycle operations (M10)', () => {
  it('walks every new operation through one registered provider', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))

    await expect(github.getMergeability(item())).resolves.toEqual({ mergeable: true, state: 'clean', blockedBy: [] })
    await expect(github.listPullRequests({ repo: repo() })).resolves.toMatchObject([{ title: 'listed:rest' }])
    await expect(github.submitReview({ item: item(), event: 'COMMENT', body: 'looks fine' })).resolves.toMatchObject({ state: 'commented' })
    await expect(github.updatePullRequest({ item: item(), title: 'new' })).resolves.toMatchObject({ title: 'updated:rest' })
    await expect(github.requestReviewers({ item: item(), reviewers: ['alice'] })).resolves.toBeUndefined()
    await expect(github.setLabels({ item: item(), labels: ['bug'] })).resolves.toEqual(['bug'])
  })

  it('caps a pull request listing at the seam, like search', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available, {
      listPullRequests: request => Promise.resolve(
        Array.from({ length: 5 }, (_, index) => pullRequest({ repo: request.repo, number: index + 1 })),
      ),
    }))
    await expect(github.listPullRequests({ repo: repo(), maxResults: 2 })).resolves.toHaveLength(2)
    await expect(github.listPullRequests({ repo: repo() })).resolves.toHaveLength(5)
  })

  it.each([
    ['a blank inline comment path', { path: '  ', line: 3, body: 'x' }],
    ['a zero line', { path: 'src/a.ts', line: 0, body: 'x' }],
    ['a fractional line', { path: 'src/a.ts', line: 1.5, body: 'x' }],
  ])('rejects %s as GITHUB_VALIDATION before reaching GitHub', async (_label, comment) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.submitReview({ item: item(), event: 'COMMENT', comments: [comment] }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it.each([
    ['getMergeability', (github: GitHubRuntime) => github.getMergeability(item(0))],
    ['submitReview', (github: GitHubRuntime) => github.submitReview({ item: item(0), event: 'COMMENT' })],
    ['updatePullRequest', (github: GitHubRuntime) => github.updatePullRequest({ item: item(0), title: 't' })],
    ['requestReviewers', (github: GitHubRuntime) => github.requestReviewers({ item: item(0) })],
    ['setLabels', (github: GitHubRuntime) => github.setLabels({ item: item(0), labels: [] })],
  ])('validates the item ref of %s', async (_label, call) => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(call(github)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('validates the repo ref and result bound of a listing', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.listPullRequests({ repo: repo({ owner: '' }) })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
    await expect(github.listPullRequests({ repo: repo(), maxResults: 0 })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
  })

  it('accepts a submission with no inline comments at all', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available))
    await expect(github.submitReview({ item: item(), event: 'APPROVE' })).resolves.toMatchObject({ state: 'approved' })
  })
})

describe('GitHubRuntime check-failure log budgets (ADR-0015)', () => {
  async function budgeted(result: GitHubCheckFailuresResult, request?: Parameters<GitHubRuntime['getCheckFailures']>[1]) {
    const { github } = await mountGitHub()
    github.registerProvider(makeProvider('rest', available, { getCheckFailures: () => Promise.resolve(result) }))
    return github.getCheckFailures(item(), request)
  }

  it('keeps only the trailing lines under maxLogLines', async () => {
    const out = await budgeted(failuresWithLog('l1\nl2\nl3\nl4'), { maxLogLines: 2 })
    expect(out.failures[0]!.log).toEqual({ text: 'l3\nl4', truncated: true })
    expect(out.truncated).toBe(true)
  })

  it('cuts to maxLogChars and realigns forward to a line start', async () => {
    // 'aaa\nbbb\nccc' tail-7 is 'bbb\nccc'; realignment drops the partial 'bbb'.
    const out = await budgeted(failuresWithLog('aaa\nbbb\nccc'), { maxLogChars: 7 })
    expect(out.failures[0]!.log).toEqual({ text: 'ccc', truncated: true })
  })

  it('keeps a partial line when the whole char budget lands inside one line', async () => {
    const out = await budgeted(failuresWithLog('abcdefghij'), { maxLogChars: 4 })
    expect(out.failures[0]!.log).toEqual({ text: 'ghij', truncated: true })
  })

  it('keeps the unaligned tail when realignment would leave nothing', async () => {
    const out = await budgeted(failuresWithLog('ab\n'), { maxLogChars: 1 })
    expect(out.failures[0]!.log).toEqual({ text: '\n', truncated: true })
  })

  it('leaves a log that exactly fits both budgets untouched', async () => {
    const out = await budgeted(failuresWithLog('abc'), { maxLogLines: 1, maxLogChars: 3 })
    expect(out.failures[0]!.log).toEqual({ text: 'abc', truncated: false })
    expect(out.truncated).toBe(false)
  })

  it('passes failures without logs through unchanged', async () => {
    const source: GitHubCheckFailuresResult = {
      failures: [{ run: failedRun(), annotations: [{ path: 'a.ts', level: 'failure', message: 'boom' }] }],
      truncated: false,
    }
    const out = await budgeted(source, { maxLogChars: 1 })
    expect(out).toBe(source)
  })

  it('propagates a provider-truncated log into the result even with no budget of its own', async () => {
    const out = await budgeted(failuresWithLog('short', true))
    expect(out.truncated).toBe(true)
    expect(out.failures[0]!.log).toEqual({ text: 'short', truncated: true })
  })
})

describe('GitHubRuntime search maxResults enforcement', () => {
  function overReturningProvider(count: number): GitHubProvider {
    return makeProvider('rest', available, {
      search: () => Promise.resolve(searchResult({
        items: Array.from({ length: count }, (_, index) => ({ title: `hit ${index}`, url: `https://github.com/${index}` })),
      })),
    })
  }

  it('truncates items and sets truncated when a provider over-returns', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(overReturningProvider(3))
    const result = await github.search({ kind: 'issues', query: 'q', maxResults: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('leaves truncated false when within the bound', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(overReturningProvider(1))
    const result = await github.search({ kind: 'issues', query: 'q', maxResults: 8 })
    expect(result.items).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('does not bound when maxResults is omitted', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(overReturningProvider(2))
    const result = await github.search({ kind: 'issues', query: 'q' })
    expect(result.items).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('GitHubRuntime diff budget enforcement (ADR-0005)', () => {
  function providerReturning(diff: GitHubDiff): GitHubProvider {
    return makeProvider('rest', available, { getDiff: () => Promise.resolve(diff) })
  }

  it('passes the diff through untouched when no budget is given', async () => {
    const { github } = await mountGitHub()
    const diff: GitHubDiff = { files: [diffFile('a.ts', '+a')], truncated: false }
    github.registerProvider(providerReturning(diff))
    await expect(github.getDiff(item())).resolves.toBe(diff)
  })

  it('keeps a provider-side truncation flag honest even when budgets are satisfied', async () => {
    const { github } = await mountGitHub()
    const diff: GitHubDiff = { files: [diffFile('a.ts', '+a')], truncated: true }
    github.registerProvider(providerReturning(diff))
    const result = await github.getDiff(item(), { maxFiles: 5, maxPatchChars: 100 })
    expect(result).toBe(diff)
    expect(result.truncated).toBe(true)
  })

  it('drops trailing files beyond maxFiles and flags truncation', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('a.ts', '+a'), diffFile('b.ts', '+b'), diffFile('c.ts', '+c')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxFiles: 2 })
    expect(result.files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(result.truncated).toBe(true)
  })

  it('leaves a diff with exactly maxFiles files untouched', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('a.ts', '+a'), diffFile('b.ts', '+b')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxFiles: 2 })
    expect(result.files).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('leaves a diff whose total patch text exactly equals maxPatchChars untouched', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('a.ts', '12345'), diffFile('b.ts', '123')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxPatchChars: 8 })
    expect(result.files.map(file => file.patch)).toEqual(['12345', '123'])
    expect(result.truncated).toBe(false)
  })

  it('cuts the overflowing patch at the remaining budget and drops later patches, keeping file metadata', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('a.ts', '12345'), diffFile('b.ts', '67890'), diffFile('c.ts', 'abcde')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxPatchChars: 8 })
    expect(result.files.map(file => file.patch)).toEqual(['12345', '678', undefined])
    expect(result.files.map(file => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(result.truncated).toBe(true)
  })

  it('truncates a single patch larger than the whole budget', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({ files: [diffFile('a.ts', 'abcdefghij')], truncated: false }))
    const result = await github.getDiff(item(), { maxPatchChars: 4 })
    expect(result.files[0]!.patch).toBe('abcd')
    expect(result.truncated).toBe(true)
  })

  it('passes patch-less (binary) files through without consuming budget', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('img.png'), diffFile('a.ts', '123')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxPatchChars: 3 })
    expect(result.files.map(file => file.patch)).toEqual([undefined, '123'])
    expect(result.truncated).toBe(false)
  })

  it('applies maxFiles before maxPatchChars so both reductions compose', async () => {
    const { github } = await mountGitHub()
    github.registerProvider(providerReturning({
      files: [diffFile('a.ts', '12345'), diffFile('b.ts', '12345'), diffFile('c.ts', '12345')],
      truncated: false,
    }))
    const result = await github.getDiff(item(), { maxFiles: 2, maxPatchChars: 7 })
    expect(result.files.map(file => file.patch)).toEqual(['12345', '12'])
    expect(result.truncated).toBe(true)
  })
})

describe('GitHubError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new GitHubError('boom', 'GITHUB_AUTH')
    expect(error.code).toBe('GITHUB_AUTH')
    expect(error.name).toBe('GitHubError')
    expect(error.retryAfterMs).toBeUndefined()
  })

  it('carries retryAfterMs for rate limits', () => {
    const error = new GitHubError('slow down', 'GITHUB_RATE_LIMITED', { retryAfterMs: 1200 })
    expect(error.retryAfterMs).toBe(1200)
  })
})

describe('dsh-github invariant companion', () => {
  it('registers with the invariant service and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(githubInvariant.name).toBe('github-invariant')
    expect(githubInvariant.inject).toEqual(['invariants'])
    const dispose = await githubInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
