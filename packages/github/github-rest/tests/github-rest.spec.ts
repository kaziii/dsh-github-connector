import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Credentials, { type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import Settings, { settingsNamespace } from '@deepseek-ai/dsh-settings'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import GitHubRuntime, { GitHubError, type GitHubItemRef, type GitHubRepoRef } from 'dsh-github'
import * as githubRest from 'dsh-github-rest'
import {
  buildUrl,
  MAX_PAGES,
  parseLinkNext,
  RestGitHubProvider,
  restPaginate,
  restRequest,
  restTextRequest,
  type RestGitHubProviderOptions,
  type RestTransport,
} from 'dsh-github-rest'
import * as restInvariant from 'dsh-github-rest/invariant'

const API = 'https://api.github.com'

function repo(): GitHubRepoRef {
  return { owner: 'octo', repo: 'hello-world' }
}

function item(number = 7): GitHubItemRef {
  return { repo: repo(), number }
}

/** One recorded fetch invocation, normalized for assertions. */
interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** A scripted fetch: routes each call through `respond`, recording everything. */
function recordingFetch(respond: (url: URL, call: RecordedCall) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    if (init?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return Promise.resolve(respond(new URL(call.url), call))
  }
  return { fetch: fetchImpl, calls }
}

function jsonResponse(json: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(json), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function textResponse(text: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers })
}

function transportOver(fetchImpl: typeof globalThis.fetch): RestTransport {
  return { baseURL: API, token: 'token-1', fetch: fetchImpl }
}

function makeProvider(fetchImpl: typeof globalThis.fetch, overrides: Partial<RestGitHubProviderOptions> = {}): RestGitHubProvider {
  return new RestGitHubProvider({
    config: () => ({ credentialRef: 'GITHUB_TOKEN', baseURL: API }),
    resolveToken: () => Promise.resolve('token-1'),
    tokenConfigured: () => true,
    fetch: fetchImpl,
    ...overrides,
  })
}

// —— wire fixtures (recorded from the REST v3 reference shapes) ——————————————

const RAW_ISSUE_FULL = {
  number: 7,
  title: 'Crash on start',
  state: 'open',
  html_url: 'https://github.com/octo/hello-world/issues/7',
  body: 'It crashes.',
  user: { login: 'octocat' },
  labels: ['question', { name: 'bug' }, {}],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  comments: 2,
}

const RAW_ISSUE_MINIMAL = { number: 8, title: 'Old one', state: 'closed' }

const RAW_PR_BRANCHES = { base: { ref: 'main', sha: 'base-sha' }, head: { ref: 'feat/x', sha: 'head-sha' } }

const RAW_PR_OPEN = { number: 5, title: 'Add feature', state: 'open', merged_at: null, ...RAW_PR_BRANCHES }

const RAW_PR_MERGED = {
  number: 6,
  title: 'Shipped',
  state: 'closed',
  merged_at: '2026-08-03T00:00:00Z',
  html_url: 'https://github.com/octo/hello-world/pull/6',
  body: 'Done.',
  user: { login: 'octocat' },
  draft: false,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-03T00:00:00Z',
  comments: 4,
  ...RAW_PR_BRANCHES,
}

const RAW_PR_CLOSED = { number: 9, title: 'Abandoned', state: 'closed', merged_at: null, ...RAW_PR_BRANCHES }

const RAW_COMMENT_FULL = {
  id: 11,
  body: 'Looks good',
  user: { login: 'octocat' },
  created_at: '2026-08-04T00:00:00Z',
  html_url: 'https://github.com/octo/hello-world/issues/7#issuecomment-11',
}

const RAW_COMMENT_MINIMAL = { id: 12, body: 'ping' }

const RAW_FILE_RENAMED = {
  filename: 'src/new.ts',
  previous_filename: 'src/old.ts',
  status: 'renamed',
  additions: 3,
  deletions: 1,
  patch: '@@ -1 +1,3 @@',
}

const RAW_FILE_BINARY = { filename: 'logo.png', status: 'surprise-status', additions: 0, deletions: 0 }

const RAW_CHECK_DONE = { name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/hello-world/runs/1' }

const RAW_CHECK_RUNNING = { name: 'lint', status: 'in_progress', conclusion: null, html_url: null }

// —— http core ————————————————————————————————————————————————————————————————

describe('buildUrl', () => {
  it('joins the default base with a path and query, omitting undefined values', () => {
    expect(buildUrl(API, '/search/issues', { q: 'is:open bug', per_page: 5, page: undefined }))
      .toBe('https://api.github.com/search/issues?q=is%3Aopen+bug&per_page=5')
  })

  it('tolerates trailing slashes on a GHES base', () => {
    expect(buildUrl('https://ghe.example.com/api/v3/', '/repos/octo/hello-world/issues/7'))
      .toBe('https://ghe.example.com/api/v3/repos/octo/hello-world/issues/7')
    expect(buildUrl('https://ghe.example.com/api/v3//', '/user')).toBe('https://ghe.example.com/api/v3/user')
  })

  it('builds a bare URL without query parameters', () => {
    expect(buildUrl(API, '/user')).toBe('https://api.github.com/user')
  })
})

describe('parseLinkNext', () => {
  it('returns undefined without a Link header', () => {
    expect(parseLinkNext(null)).toBeUndefined()
  })

  it('finds the next relation among others', () => {
    const header = '<https://api.github.com/x?page=3>; rel="last", <https://api.github.com/x?page=2>; rel="next"'
    expect(parseLinkNext(header)).toBe('https://api.github.com/x?page=2')
  })

  it('returns undefined when no next relation exists', () => {
    expect(parseLinkNext('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined()
  })
})

describe('restRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the GitHub headers and returns the parsed body', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({ ok: true }))
    const result = await restRequest(transportOver(fetchImpl), `${API}/user`)
    expect(result.json).toEqual({ ok: true })
    expect(result.next).toBeUndefined()
    expect(calls[0]).toMatchObject({
      method: 'GET',
      headers: {
        'accept': 'application/vnd.github+json',
        'authorization': 'Bearer token-1',
        'user-agent': 'dsh-github-rest',
        'x-github-api-version': '2022-11-28',
      },
      body: undefined,
    })
    expect(calls[0]!.headers['content-type']).toBeUndefined()
  })

  it('serializes a POST body as JSON with its content type', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({}, { status: 201 }))
    await restRequest(transportOver(fetchImpl), `${API}/repos/octo/hello-world/issues`, { method: 'POST', body: { title: 't' } })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"t"}',
    })
  })

  it('surfaces the next-page URL from the Link header', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse([], { headers: { link: `<${API}/x?page=2>; rel="next"` } }))
    const result = await restRequest(transportOver(fetchImpl), `${API}/x`)
    expect(result.next).toBe(`${API}/x?page=2`)
  })

  it.each([
    ['401 with an API message', textResponse('{"message":"Bad credentials"}', 401), 'GITHUB_AUTH', /Bad credentials/],
    ['404', textResponse('<html>lost</html>', 404), 'GITHUB_NOT_FOUND', /not found/],
    ['422 keeping the message verbatim', textResponse('{"message":"Validation Failed"}', 422), 'GITHUB_VALIDATION', /Validation Failed/],
    ['500 with a bodyless diagnostic', textResponse('{}', 500), 'GITHUB_PROVIDER_HTTP', /HTTP 500/],
    ['502 with a null JSON body', textResponse('null', 502), 'GITHUB_PROVIDER_HTTP', /HTTP 502/],
    ['503 with a non-string message', textResponse('{"message":5}', 503), 'GITHUB_PROVIDER_HTTP', /HTTP 503/],
    ['504 with a primitive JSON body', textResponse('5', 504), 'GITHUB_PROVIDER_HTTP', /HTTP 504/],
    ['403 without rate-limit evidence', textResponse('{"message":"Forbidden"}', 403), 'GITHUB_PROVIDER_HTTP', /Forbidden/],
    ['429 without a usable retry-after', textResponse('slow!', 429, { 'retry-after': 'soon' }), 'GITHUB_PROVIDER_HTTP', /HTTP 429/],
  ])('maps %s', async (_label, response, code, message) => {
    const { fetch: fetchImpl } = recordingFetch(() => response)
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code, message: expect.stringMatching(message) }))
  })

  it('maps a retry-after rate limit to GITHUB_RATE_LIMITED with milliseconds', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('{"message":"rate limited"}', 429, { 'retry-after': '30' }))
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_RATE_LIMITED', retryAfterMs: 30_000 }))
  })

  it('derives the wait from the primary-quota reset epoch when retry-after is absent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    const reset = String(1_000_000_000 + 30)
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }))
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_RATE_LIMITED', retryAfterMs: 30_000 }))
  })

  it('clamps a reset epoch in the past to zero wait', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999999000' }))
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_RATE_LIMITED', retryAfterMs: 0 }))
  })

  it('treats an unusable reset epoch as no rate-limit evidence', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'later' }))
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_HTTP' }))
  })

  it('maps an aborted request to GITHUB_ABORTED', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse({}))
    const controller = new AbortController()
    controller.abort()
    await expect(restRequest(transportOver(fetchImpl), `${API}/x`, { signal: controller.signal }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_ABORTED' }))
  })

  it('maps a transport failure to GITHUB_PROVIDER_NETWORK', async () => {
    const failing: typeof globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'))
    await expect(restRequest(transportOver(failing), `${API}/x`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_NETWORK' }))
  })

  it('keeps a live signal out of the abort classification', async () => {
    const failing: typeof globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'))
    const controller = new AbortController()
    await expect(restRequest(transportOver(failing), `${API}/x`, { signal: controller.signal }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_NETWORK' }))
  })
})

describe('restPaginate', () => {
  function pagedFetch(pages: number, perPage = 1): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
    return recordingFetch(url => {
      const page = Number(url.searchParams.get('page') ?? '1')
      const items = Array.from({ length: perPage }, (_, index) => `p${page}i${index}`)
      const headers = page < pages ? { link: `<${API}/list?page=${page + 1}>; rel="next"` } : {}
      return jsonResponse(items, { headers })
    })
  }

  it('follows the Link chain and reports exhaustion', async () => {
    const { fetch: fetchImpl, calls } = pagedFetch(3)
    const result = await restPaginate(transportOver(fetchImpl), `${API}/list`, json => json as string[])
    expect(result.items).toEqual(['p1i0', 'p2i0', 'p3i0'])
    expect(result.exhausted).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('stops at the page cap and reports non-exhaustion', async () => {
    const { fetch: fetchImpl, calls } = pagedFetch(MAX_PAGES + 5)
    const result = await restPaginate(transportOver(fetchImpl), `${API}/list`, json => json as string[])
    expect(result.items).toHaveLength(MAX_PAGES)
    expect(result.exhausted).toBe(false)
    expect(calls).toHaveLength(MAX_PAGES)
  })

  it('stops early once the enough predicate is satisfied', async () => {
    const { fetch: fetchImpl, calls } = pagedFetch(4, 2)
    const result = await restPaginate(
      transportOver(fetchImpl),
      `${API}/list`,
      json => json as string[],
      {},
      items => items.length >= 3,
    )
    expect(result.items).toHaveLength(4)
    expect(result.exhausted).toBe(false)
    expect(calls).toHaveLength(2)
  })
})

// —— provider fixture replay —————————————————————————————————————————————————

describe('RestGitHubProvider search', () => {
  it('searches issues through /search/issues with the is:issue qualifier', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({
      total_count: 2,
      items: [
        {
          number: 7,
          title: 'Crash on start',
          state: 'open',
          html_url: 'https://github.com/octo/hello-world/issues/7',
          repository_url: 'https://api.github.com/repos/octo/hello-world',
        },
        { number: 3, title: 'Ancient bug', state: 'closed' },
      ],
    }))
    const result = await makeProvider(fetchImpl).search({ kind: 'issues', query: 'crash' })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/search/issues')
    expect(url.searchParams.get('q')).toBe('crash is:issue')
    expect(url.searchParams.get('per_page')).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.items).toEqual([
      {
        title: 'Crash on start',
        url: 'https://github.com/octo/hello-world/issues/7',
        repo: { owner: 'octo', repo: 'hello-world' },
        number: 7,
        state: 'open',
      },
      { title: 'Ancient bug', url: '', number: 3, state: 'closed' },
    ])
  })

  it('searches pull requests through /search/issues, surfacing merged state', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({
      total_count: 40,
      items: [
        {
          number: 6,
          title: 'Shipped',
          state: 'closed',
          html_url: 'https://github.com/octo/hello-world/pull/6',
          repository_url: 'https://api.github.com/repos/octo/hello-world',
          pull_request: { merged_at: '2026-08-03T00:00:00Z' },
        },
        {
          number: 5,
          title: 'Open PR',
          state: 'open',
          html_url: 'https://github.com/octo/hello-world/pull/5',
          repository_url: 'https://strange.example.com/not-repos',
          pull_request: { merged_at: null },
        },
      ],
    }))
    const result = await makeProvider(fetchImpl).search({ kind: 'pull-requests', query: 'feature', maxResults: 2 })
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('q')).toBe('feature is:pr')
    expect(url.searchParams.get('per_page')).toBe('2')
    expect(result.truncated).toBe(true)
    expect(result.items[0]).toMatchObject({ state: 'merged', repo: { owner: 'octo', repo: 'hello-world' } })
    expect(result.items[1]).toEqual({ title: 'Open PR', url: 'https://github.com/octo/hello-world/pull/5', number: 5, state: 'open' })
  })

  it('searches repositories, capping per_page at the API maximum', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({
      total_count: 2,
      items: [
        { full_name: 'octo/hello-world', html_url: 'https://github.com/octo/hello-world', description: 'demo' },
        { full_name: 'octo/deep/nested', html_url: 'https://github.com/octo/deep', description: null },
      ],
    }))
    const result = await makeProvider(fetchImpl).search({ kind: 'repositories', query: 'hello', maxResults: 500 })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/search/repositories')
    expect(url.searchParams.get('q')).toBe('hello')
    expect(url.searchParams.get('per_page')).toBe('100')
    expect(result.items).toEqual([
      { title: 'octo/hello-world', url: 'https://github.com/octo/hello-world', repo: { owner: 'octo', repo: 'hello-world' }, snippet: 'demo' },
      { title: 'octo/deep/nested', url: 'https://github.com/octo/deep' },
    ])
  })

  it('searches code, addressing hits by path and repository', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({
      total_count: 1,
      items: [{ path: 'src/index.ts', html_url: 'https://github.com/octo/hello-world/blob/main/src/index.ts', repository: { full_name: 'octo/hello-world' } }],
    }))
    const result = await makeProvider(fetchImpl).search({ kind: 'code', query: 'registerProvider' })
    expect(new URL(calls[0]!.url).pathname).toBe('/search/code')
    expect(result.items).toEqual([
      { title: 'src/index.ts', url: 'https://github.com/octo/hello-world/blob/main/src/index.ts', repo: { owner: 'octo', repo: 'hello-world' } },
    ])
  })
})

describe('RestGitHubProvider reads', () => {
  it('reads a full issue', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_FULL))
    const issue = await makeProvider(fetchImpl).getIssue(item(7))
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/issues/7`)
    expect(issue).toEqual({
      ref: { repo: repo(), number: 7, url: 'https://github.com/octo/hello-world/issues/7' },
      title: 'Crash on start',
      state: 'open',
      body: 'It crashes.',
      author: 'octocat',
      labels: ['question', 'bug'],
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      commentCount: 2,
    })
  })

  it('reads a minimal closed issue without optional fields', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    const issue = await makeProvider(fetchImpl).getIssue(item(8))
    expect(issue).toEqual({ ref: { repo: repo(), number: 8 }, title: 'Old one', state: 'closed' })
  })

  it.each([
    ['open', RAW_PR_OPEN, 'open'],
    ['merged', RAW_PR_MERGED, 'merged'],
    ['closed unmerged', RAW_PR_CLOSED, 'closed'],
  ])('reads a %s pull request', async (_label, raw, state) => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(raw))
    const pr = await makeProvider(fetchImpl).getPullRequest(item(raw.number))
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/pulls/${raw.number}`)
    expect(pr.state).toBe(state)
    expect(pr).toMatchObject({ baseRef: 'main', headRef: 'feat/x' })
  })

  it('keeps merged PR metadata intact', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse(RAW_PR_MERGED))
    const pr = await makeProvider(fetchImpl).getPullRequest(item(6))
    expect(pr).toEqual({
      ref: { repo: repo(), number: 6, url: 'https://github.com/octo/hello-world/pull/6' },
      title: 'Shipped',
      state: 'merged',
      baseRef: 'main',
      headRef: 'feat/x',
      body: 'Done.',
      author: 'octocat',
      draft: false,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-03T00:00:00Z',
      commentCount: 4,
    })
  })

  it('aggregates comments across pages', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(url => {
      if (url.searchParams.get('page') === '2') return jsonResponse([RAW_COMMENT_MINIMAL])
      return jsonResponse([RAW_COMMENT_FULL], {
        headers: { link: `<${API}/repos/octo/hello-world/issues/7/comments?per_page=100&page=2>; rel="next"` },
      })
    })
    const comments = await makeProvider(fetchImpl).getComments(item(7))
    expect(new URL(calls[0]!.url).searchParams.get('per_page')).toBe('100')
    expect(comments).toEqual([
      {
        id: 11,
        body: 'Looks good',
        author: 'octocat',
        createdAt: '2026-08-04T00:00:00Z',
        url: 'https://github.com/octo/hello-world/issues/7#issuecomment-11',
      },
      { id: 12, body: 'ping' },
    ])
  })

  it('reads a diff, normalizing statuses and binary files', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse([RAW_FILE_RENAMED, RAW_FILE_BINARY]))
    const diff = await makeProvider(fetchImpl).getDiff(item(5), {})
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/pulls/5/files?per_page=100`)
    expect(diff).toEqual({
      files: [
        { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@' },
        { path: 'logo.png', status: 'changed', additions: 0, deletions: 0 },
      ],
      truncated: false,
    })
  })

  it('stops fetching diff pages once maxFiles is satisfiable and reports truncation', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(url => {
      const page = Number(url.searchParams.get('page') ?? '1')
      return jsonResponse([{ ...RAW_FILE_RENAMED, filename: `file-${page}.ts` }], {
        headers: { link: `<${API}/repos/octo/hello-world/pulls/5/files?per_page=100&page=${page + 1}>; rel="next"` },
      })
    })
    const diff = await makeProvider(fetchImpl).getDiff(item(5), { maxFiles: 2 })
    expect(calls).toHaveLength(2)
    expect(diff.files.map(file => file.path)).toEqual(['file-1.ts', 'file-2.ts'])
    expect(diff.truncated).toBe(true)
  })

  it('leaves the diff unmarked when a maxFiles budget is never reached', async () => {
    const { fetch: fetchImpl } = recordingFetch(url => {
      if (url.searchParams.get('page') === '2') return jsonResponse([RAW_FILE_BINARY])
      return jsonResponse([RAW_FILE_RENAMED], { headers: { link: `<${API}/repos/octo/hello-world/pulls/5/files?per_page=100&page=2>; rel="next"` } })
    })
    const diff = await makeProvider(fetchImpl).getDiff(item(5), { maxFiles: 300 })
    expect(diff.files).toHaveLength(2)
    expect(diff.truncated).toBe(false)
  })

  it('reads checks by resolving the head sha first', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(url => {
      if (url.pathname.endsWith('/pulls/5')) return jsonResponse(RAW_PR_OPEN)
      return jsonResponse({ check_runs: [RAW_CHECK_DONE, RAW_CHECK_RUNNING] })
    })
    const checks = await makeProvider(fetchImpl).getChecks(item(5))
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/pulls/5`)
    expect(calls[1]!.url).toBe(`${API}/repos/octo/hello-world/commits/head-sha/check-runs?per_page=100`)
    expect(checks).toEqual({
      runs: [
        { name: 'ci', status: 'completed', conclusion: 'success', url: 'https://github.com/octo/hello-world/runs/1' },
        { name: 'lint', status: 'in_progress' },
      ],
    })
  })
})

// —— M8 review / CI-failure fixtures ——————————————————————————————————————

const RAW_REVIEW_APPROVED = {
  id: 11,
  state: 'APPROVED',
  user: { login: 'alice' },
  body: 'LGTM',
  submitted_at: '2026-08-04T00:00:00Z',
  html_url: 'https://github.com/octo/hello-world/pull/5#pullrequestreview-11',
}

const RAW_REVIEW_UNKNOWN_STATE = { id: 12, state: 'SOMETHING_NEW', submitted_at: null }

const RAW_REVIEW_COMMENT_FULL = {
  id: 21,
  path: 'src/a.ts',
  body: 'this leaks',
  side: 'RIGHT',
  line: 42,
  diff_hunk: '@@ -1 +1 @@',
  user: { login: 'bob' },
  created_at: '2026-08-04T01:00:00Z',
  html_url: 'https://github.com/octo/hello-world/pull/5#discussion_r21',
  in_reply_to_id: 20,
}

const RAW_REVIEW_COMMENT_LEFT = { id: 22, path: 'src/b.ts', body: 'was wrong before', side: 'LEFT', line: null }

const RAW_REVIEW_COMMENT_NO_SIDE = { id: 23, path: 'src/c.ts', body: 'no side field' }

const JOB_LOG_URL = 'https://pipelines.actions.githubusercontent.com/signed/job-101'

const RAW_CHECK_FAILED = {
  id: 101,
  name: 'build',
  status: 'completed',
  conclusion: 'failure',
  details_url: 'https://github.com/octo/hello-world/actions/runs/9/job/101',
}

const RAW_CHECK_FAILED_NO_JOB = {
  id: 102,
  name: 'external-scan',
  status: 'completed',
  conclusion: 'timed_out',
  details_url: 'https://scanner.example.com/report/7',
}

const RAW_ANNOTATION = {
  path: 'src/a.ts',
  annotation_level: 'failure',
  message: 'TS2345: not assignable',
  title: 'tsc',
  start_line: 10,
  end_line: 12,
}

const RAW_ANNOTATION_UNKNOWN_LEVEL = { path: 'src/b.ts', annotation_level: 'catastrophe', message: 'unmapped level' }

/** The wire shape when a tool reports a finding without any severity at all. */
const RAW_ANNOTATION_NO_LEVEL = { path: 'src/c.ts', message: 'no level given' }

describe('RestGitHubProvider review reads', () => {
  it('maps review states onto the seam vocabulary, degrading unknown states to commented', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse([RAW_REVIEW_APPROVED, RAW_REVIEW_UNKNOWN_STATE]))
    const reviews = await makeProvider(fetchImpl).getReviews(item(5))
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/pulls/5/reviews?per_page=100`)
    expect(reviews).toEqual([
      {
        id: 11,
        state: 'approved',
        author: 'alice',
        body: 'LGTM',
        submittedAt: '2026-08-04T00:00:00Z',
        url: 'https://github.com/octo/hello-world/pull/5#pullrequestreview-11',
      },
      { id: 12, state: 'commented' },
    ])
  })

  it('reads line-anchored review comments from the pulls endpoint, not the issues one', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() =>
      jsonResponse([RAW_REVIEW_COMMENT_FULL, RAW_REVIEW_COMMENT_LEFT, RAW_REVIEW_COMMENT_NO_SIDE]))
    const comments = await makeProvider(fetchImpl).getReviewComments(item(5))
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/pulls/5/comments?per_page=100`)
    expect(comments).toEqual([
      {
        id: 21,
        path: 'src/a.ts',
        body: 'this leaks',
        side: 'right',
        line: 42,
        diffHunk: '@@ -1 +1 @@',
        author: 'bob',
        createdAt: '2026-08-04T01:00:00Z',
        url: 'https://github.com/octo/hello-world/pull/5#discussion_r21',
        inReplyToId: 20,
      },
      { id: 22, path: 'src/b.ts', body: 'was wrong before', side: 'left' },
      { id: 23, path: 'src/c.ts', body: 'no side field', side: 'right' },
    ])
  })
})

describe('RestGitHubProvider CI failure evidence (ADR-0015)', () => {
  /** Route the shared prelude (PR → check-runs) and delegate the rest. */
  function failureFetch(
    runs: readonly unknown[],
    rest: (url: URL, call: RecordedCall) => Response | Promise<Response>,
  ): ReturnType<typeof recordingFetch> {
    return recordingFetch((url, call) => {
      if (url.pathname.endsWith('/pulls/5')) return jsonResponse(RAW_PR_OPEN)
      if (url.pathname.endsWith('/check-runs')) return jsonResponse({ check_runs: runs })
      return rest(url, call)
    })
  }

  it('prefers annotations and never fetches the log when they exist', async () => {
    const { fetch: fetchImpl, calls } = failureFetch([RAW_CHECK_FAILED, RAW_CHECK_DONE], () =>
      jsonResponse([RAW_ANNOTATION, RAW_ANNOTATION_UNKNOWN_LEVEL, RAW_ANNOTATION_NO_LEVEL]))
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(calls.some(call => call.url.includes('/logs'))).toBe(false)
    expect(result).toEqual({
      failures: [{
        run: { name: 'build', status: 'completed', conclusion: 'failure' },
        annotations: [
          { path: 'src/a.ts', level: 'failure', message: 'TS2345: not assignable', title: 'tsc', startLine: 10, endLine: 12 },
          // An unmapped level degrades downward rather than inventing severity.
          { path: 'src/b.ts', level: 'notice', message: 'unmapped level' },
          { path: 'src/c.ts', level: 'notice', message: 'no level given' },
        ],
      }],
      truncated: false,
    })
  })

  it('falls back to the job log when a run reported no annotations, following the redirect without the credential', async () => {
    const { fetch: fetchImpl, calls } = failureFetch([RAW_CHECK_FAILED], url => {
      if (url.pathname.endsWith('/annotations')) return jsonResponse([])
      if (url.pathname.endsWith('/logs')) return new Response(null, { status: 302, headers: { location: JOB_LOG_URL } })
      return textResponse('step failed\nexit 1\n', 200)
    })
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(result.failures[0]!.log).toEqual({ text: 'step failed\nexit 1\n', truncated: false })

    const followed = calls.find(call => call.url === JOB_LOG_URL)!
    // ADR-0015: the storage host is a different origin — our token must not travel there.
    expect(followed.headers).not.toHaveProperty('authorization')
    expect(calls.find(call => call.url.endsWith('/logs'))!.headers.authorization).toBe('Bearer token-1')
  })

  it('fetches the log alongside annotations when includeLogs is set', async () => {
    const { fetch: fetchImpl, calls } = failureFetch([RAW_CHECK_FAILED], url => {
      if (url.pathname.endsWith('/annotations')) return jsonResponse([RAW_ANNOTATION])
      return textResponse('tail', 200)
    })
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), { includeLogs: true })
    expect(calls.some(call => call.url.includes('/logs'))).toBe(true)
    expect(result.failures[0]!.annotations).toHaveLength(1)
    expect(result.failures[0]!.log).toEqual({ text: 'tail', truncated: false })
  })

  it('reports a failure with no evidence when the log has expired (410)', async () => {
    const { fetch: fetchImpl } = failureFetch([RAW_CHECK_FAILED], url => {
      if (url.pathname.endsWith('/annotations')) return jsonResponse([])
      return jsonResponse({ message: 'Not Found' }, { status: 410 })
    })
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(result.failures).toEqual([{
      run: { name: 'build', status: 'completed', conclusion: 'failure' },
      annotations: [],
    }])
  })

  it('skips the log for a check run whose details_url names no job, and for one with no details_url at all', async () => {
    const nullUrl = { id: 103, name: 'legacy', status: 'completed', conclusion: 'failure', details_url: null }
    const absentUrl = { id: 104, name: 'ancient', status: 'completed', conclusion: 'cancelled' }
    // Annotations stay empty so the log path IS attempted and can only be
    // skipped for want of a job id — an annotation would short-circuit it first.
    const { fetch: fetchImpl, calls } = failureFetch([RAW_CHECK_FAILED_NO_JOB, nullUrl, absentUrl], () => jsonResponse([]))
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(calls.some(call => call.url.includes('/logs'))).toBe(false)
    expect(result.failures.map(failure => failure.run.name)).toEqual(['external-scan', 'legacy', 'ancient'])
    expect(result.failures.every(failure => failure.log === undefined)).toBe(true)
  })

  it('ignores runs that did not fail, including ones still running', async () => {
    const { fetch: fetchImpl } = failureFetch([RAW_CHECK_DONE, RAW_CHECK_RUNNING], () => jsonResponse([]))
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(result).toEqual({ failures: [], truncated: false })
  })

  it('marks the result truncated when an annotation listing leaves a page behind', async () => {
    const { fetch: fetchImpl } = failureFetch([RAW_CHECK_FAILED], url => {
      const page = Number(url.searchParams.get('page') ?? '1')
      return jsonResponse([RAW_ANNOTATION], {
        headers: { link: `<${API}/repos/octo/hello-world/check-runs/101/annotations?page=${page + 1}>; rel="next"` },
      })
    })
    const result = await makeProvider(fetchImpl).getCheckFailures(item(5), {})
    expect(result.truncated).toBe(true)
    expect(result.failures[0]!.annotations).toHaveLength(MAX_PAGES)
  })

  it('propagates a non-404 log failure instead of swallowing it as missing evidence', async () => {
    const { fetch: fetchImpl } = failureFetch([RAW_CHECK_FAILED], url => {
      if (url.pathname.endsWith('/annotations')) return jsonResponse([])
      return jsonResponse({ message: 'boom' }, { status: 500 })
    })
    await expect(makeProvider(fetchImpl).getCheckFailures(item(5), {}))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_HTTP' }))
  })
})

describe('restTextRequest', () => {
  it('returns the body directly when the endpoint does not redirect', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('inline log', 200))
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`)).resolves.toBe('inline log')
  })

  it('maps a redirect without a location header to GITHUB_PROVIDER_HTTP', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => new Response(null, { status: 302 }))
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_HTTP' }))
  })

  it('maps a failure at the redirect target, not at the API', async () => {
    const { fetch: fetchImpl } = recordingFetch(url =>
      url.hostname === 'api.github.com'
        ? new Response(null, { status: 302, headers: { location: JOB_LOG_URL } })
        : textResponse('gone', 404))
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_NOT_FOUND' }))
  })

  it('maps HTTP 410 to GITHUB_NOT_FOUND so expired logs read as absence', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('', 410))
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_NOT_FOUND' }))
  })

  it('carries the abort signal across the redirect hop', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      seen.push(init?.signal ?? undefined)
      return Promise.resolve(String(input).startsWith(API)
        ? new Response(null, { status: 302, headers: { location: JOB_LOG_URL } })
        : textResponse('tail', 200))
    }
    const controller = new AbortController()
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`, { signal: controller.signal })).resolves.toBe('tail')
    expect(seen).toEqual([controller.signal, controller.signal])
  })

  it('forwards abort as GITHUB_ABORTED', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => textResponse('never', 200))
    const controller = new AbortController()
    controller.abort()
    await expect(restTextRequest(transportOver(fetchImpl), `${API}/x/logs`, { signal: controller.signal }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_ABORTED' }))
  })
})

describe('RestGitHubProvider writes', () => {
  it('creates an issue with only the provided fields', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL, { status: 201 }))
    await makeProvider(fetchImpl).createIssue({ repo: repo(), title: 'Old one' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/repos/octo/hello-world/issues`, body: '{"title":"Old one"}' })
  })

  it('creates a labelled issue with a body', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_FULL, { status: 201 }))
    const issue = await makeProvider(fetchImpl).createIssue({ repo: repo(), title: 'Crash on start', body: 'It crashes.', labels: ['bug'] })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Crash on start', body: 'It crashes.', labels: ['bug'] })
    expect(issue.title).toBe('Crash on start')
  })

  it('creates a comment', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_COMMENT_FULL, { status: 201 }))
    const comment = await makeProvider(fetchImpl).createComment({ item: item(7), body: 'Looks good' })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/repos/octo/hello-world/issues/7/comments`,
      body: '{"body":"Looks good"}',
    })
    expect(comment.id).toBe(11)
  })
})

describe('RestGitHubProvider idempotent pull request creation (ADR-0004)', () => {
  const request = { repo: repo(), title: 'Add feature', head: 'feat/x', base: 'main' }

  it('returns the existing open PR without posting', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse([RAW_PR_OPEN]))
    const result = await makeProvider(fetchImpl).createPullRequest(request)
    expect(result.created).toBe(false)
    expect(result.pullRequest.ref.number).toBe(5)
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/repos/octo/hello-world/pulls')
    expect(url.searchParams.get('head')).toBe('octo:feat/x')
    expect(url.searchParams.get('base')).toBe('main')
    expect(url.searchParams.get('state')).toBe('open')
  })

  it('posts when no open PR exists, passing body and draft through', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch((url, call) =>
      call.method === 'POST' ? jsonResponse(RAW_PR_OPEN, { status: 201 }) : jsonResponse([]))
    const result = await makeProvider(fetchImpl).createPullRequest({ ...request, body: 'Please review', draft: true })
    expect(result.created).toBe(true)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      title: 'Add feature',
      head: 'feat/x',
      base: 'main',
      body: 'Please review',
      draft: true,
    })
  })

  it('resolves a lost creation race through the 422 fallback lookup', async () => {
    let lookups = 0
    const { fetch: fetchImpl, calls } = recordingFetch((_url, call) => {
      if (call.method === 'POST') return textResponse('{"message":"A pull request already exists for octo:feat/x."}', 422)
      lookups += 1
      return lookups === 1 ? jsonResponse([]) : jsonResponse([RAW_PR_OPEN])
    })
    const result = await makeProvider(fetchImpl).createPullRequest(request)
    expect(result.created).toBe(false)
    expect(result.pullRequest.ref.number).toBe(5)
    expect(calls).toHaveLength(3)
  })

  it('rethrows when the 422 fallback lookup still finds nothing', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch((_url, call) =>
      call.method === 'POST' ? textResponse('{"message":"A pull request already exists for octo:feat/x."}', 422) : jsonResponse([]))
    await expect(makeProvider(fetchImpl).createPullRequest(request))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
    expect(calls).toHaveLength(3)
  })

  it('rethrows a non-already-exists validation failure without a fallback lookup', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch((_url, call) =>
      call.method === 'POST' ? textResponse('{"message":"Validation Failed: base invalid"}', 422) : jsonResponse([]))
    await expect(makeProvider(fetchImpl).createPullRequest(request))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION' }))
    expect(calls).toHaveLength(2)
  })

  it('rethrows a non-validation failure untouched', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch((_url, call) =>
      call.method === 'POST' ? textResponse('down', 500) : jsonResponse([]))
    await expect(makeProvider(fetchImpl).createPullRequest(request))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_HTTP' }))
    expect(calls).toHaveLength(2)
  })

  it('lets a non-GitHubError escape the fallback untouched', async () => {
    const { fetch: fetchImpl } = recordingFetch((_url, call) =>
      call.method === 'POST' ? textResponse('not-json', 201) : jsonResponse([]))
    await expect(makeProvider(fetchImpl).createPullRequest(request)).rejects.toThrow(SyntaxError)
  })
})

describe('RestGitHubProvider transport assembly', () => {
  it('throws GITHUB_AUTH when the credential resolves to nothing', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({}))
    const provider = makeProvider(fetchImpl, { resolveToken: () => Promise.resolve(undefined) })
    await expect(provider.getIssue(item()))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_AUTH', message: expect.stringMatching(/GITHUB_TOKEN/) }))
    expect(calls).toHaveLength(0)
  })

  it('resolves the credential and config on every operation', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    const tokens = ['first-token', 'second-token']
    const bases = [API, 'https://ghe.example.com/api/v3']
    let call = 0
    const provider = makeProvider(fetchImpl, {
      config: () => ({ credentialRef: 'GITHUB_TOKEN', baseURL: bases[call]! }),
      resolveToken: () => Promise.resolve(tokens[call++]),
    })
    await provider.getIssue(item(8))
    await provider.getIssue(item(8))
    expect(calls[0]!.headers['authorization']).toBe('Bearer first-token')
    expect(calls[0]!.url).toBe(`${API}/repos/octo/hello-world/issues/8`)
    expect(calls[1]!.headers['authorization']).toBe('Bearer second-token')
    expect(calls[1]!.url).toBe('https://ghe.example.com/api/v3/repos/octo/hello-world/issues/8')
  })

  it('forwards the abort signal on every request of an operation', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seen.push(init?.signal ?? undefined)
      return Promise.resolve(jsonResponse([]))
    }
    const controller = new AbortController()
    await makeProvider(fetchImpl).createPullRequest({ repo: repo(), title: 't', head: 'h', base: 'b' }, controller.signal)
      .catch(() => undefined)
    expect(seen.length).toBeGreaterThan(0)
    for (const signal of seen) expect(signal).toBe(controller.signal)
  })

  it('answers available() from the local configured check without touching the network', () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse({}))
    let configured = false
    const provider = makeProvider(fetchImpl, { tokenConfigured: () => configured })
    expect(provider.available()).toBe(false)
    configured = true
    expect(provider.available()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('falls back to the platform fetch when none is injected', () => {
    const provider = new RestGitHubProvider({
      config: () => ({ credentialRef: 'GITHUB_TOKEN', baseURL: API }),
      resolveToken: () => Promise.resolve(undefined),
      tokenConfigured: () => false,
    })
    expect(provider.available()).toBe(false)
  })
})

// —— REAL composition through the seam ———————————————————————————————————————

class FakeCredentials extends Credentials {
  store = new Map<string, string>()

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value === '' ? undefined : { value, source: 'fake' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.store.has(ref), writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
    return Promise.resolve()
  }
}

class FakeSettings extends Settings {
  override readonly writable = true

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected override persist(): Promise<void> {
    return Promise.resolve()
  }
}

/** Let queued fibers (inject sub-scopes, watchers) settle. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('dsh-github-rest plugin composition', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN
    vi.unstubAllGlobals()
  })

  it('exports a function plugin without a default export (engineering gate §8)', () => {
    expect(githubRest.name).toBe('github-rest')
    expect(githubRest.inject).toEqual(['github'])
    expect('default' in githubRest).toBe(false)
  })

  it('serves seam operations with the environment token when no credentials seam is mounted', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    vi.stubGlobal('fetch', fetchImpl)
    process.env.GITHUB_TOKEN = ' env-token '
    const ctx = new Context()
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(githubRest)
    const issue = await ctx.github.getIssue(item(8))
    expect(issue.title).toBe('Old one')
    expect(calls[0]!.headers['authorization']).toBe('Bearer env-token')
  })

  it('drops availability when the environment token disappears or blanks', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    vi.stubGlobal('fetch', fetchImpl)
    process.env.GITHUB_TOKEN = 'env-token'
    const ctx = new Context()
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(githubRest)
    await expect(ctx.github.getIssue(item(8))).resolves.toBeDefined()
    process.env.GITHUB_TOKEN = '  '
    await expect(ctx.github.getIssue(item(8)))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
    delete process.env.GITHUB_TOKEN
    await expect(ctx.github.getIssue(item(8)))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_PROVIDER_UNAVAILABLE' }))
  })

  it('prefers the credentials seam over the environment and re-resolves per operation', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    vi.stubGlobal('fetch', fetchImpl)
    process.env.GITHUB_TOKEN = 'env-token'
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(githubRest)
    const credentials = ctx.get('credentials') as FakeCredentials

    credentials.store.set('GITHUB_TOKEN', 'cred-token')
    await ctx.github.getIssue(item(8))
    expect(calls[0]!.headers['authorization']).toBe('Bearer cred-token')

    credentials.store.set('GITHUB_TOKEN', 'rotated-token')
    await ctx.github.getIssue(item(8))
    expect(calls[1]!.headers['authorization']).toBe('Bearer rotated-token')

    credentials.store.delete('GITHUB_TOKEN')
    await ctx.github.getIssue(item(8))
    expect(calls[2]!.headers['authorization']).toBe('Bearer env-token')

    delete process.env.GITHUB_TOKEN
    await expect(ctx.github.getIssue(item(8)))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_AUTH' }))
  })

  it('rejects an unusable credential ref as GITHUB_VALIDATION when resolving through the seam', async () => {
    const { fetch: fetchImpl } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    vi.stubGlobal('fetch', fetchImpl)
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(githubRest, { credentialRef: 'not a ref!' })
    await expect(ctx.github.getIssue(item(8)))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_VALIDATION', message: expect.stringMatching(/not a ref!/) }))
  })

  it('applies settings changes live and falls back to the entry config on detach', async () => {
    const { fetch: fetchImpl, calls } = recordingFetch(() => jsonResponse(RAW_ISSUE_MINIMAL))
    vi.stubGlobal('fetch', fetchImpl)
    process.env.GITHUB_TOKEN = 'env-token'
    const ctx = new Context()
    const settingsFiber = await ctx.plugin(FakeSettings)
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(githubRest)
    await settle()

    await ctx.settings.update(settingsNamespace('github-rest'), { baseURL: 'https://ghe.example.com/api/v3' })
    await ctx.github.getIssue(item(8))
    expect(calls[0]!.url).toBe('https://ghe.example.com/api/v3/repos/octo/hello-world/issues/8')

    await settingsFiber.dispose()
    await settle()
    await ctx.github.getIssue(item(8))
    expect(calls[1]!.url).toBe(`${API}/repos/octo/hello-world/issues/8`)
  })
})

describe('dsh-github-rest invariant companion', () => {
  it('registers with the invariant service and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(restInvariant.name).toBe('github-rest-invariant')
    expect(restInvariant.inject).toEqual(['invariants'])
    const dispose = await restInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
