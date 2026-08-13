import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import GitHubRuntime, {
  GitHubError,
  type GitHubComment,
  type GitHubDiff,
  type GitHubDiffFile,
  type GitHubIssue,
  type GitHubItemRef,
  type GitHubProvider,
  type GitHubPullRequest,
  type GitHubRepoRef,
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
