import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Credentials, { type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import GitHubRuntime, { GitHubError, type GitHubProvider } from 'dsh-github'
import GitHubConnectService, {
  defaultSleep,
  detectBaseBranch,
  detectFlowState,
  parseGitHubRemote,
  pollForToken,
  requestDeviceCode,
  runDeviceFlow,
  summarizeChecks,
  terminalUpdate,
  type DeviceFlowDeps,
  type DeviceFlowUpdate,
  type FlowStateDeps,
  type GitHubConnectConfig,
  type GitHubFlowState,
} from 'dsh-github-connect'
import * as connectInvariant from 'dsh-github-connect/invariant'

// —— shared helpers ———————————————————————————————————————————————————————————

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

const repos: string[] = []

afterAll(async () => {
  for (const dir of repos) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** Create a fixture git repository, optionally remoted, branched, and ahead. */
async function makeRepo(options: {
  remote?: string
  branch?: string
  ahead?: number
  originRef?: boolean
  detached?: boolean
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-connect-'))
  repos.push(dir)
  await git(['init', '-b', 'main'], dir)
  await git(['config', 'user.email', 'test@example.com'], dir)
  await git(['config', 'user.name', 'Test'], dir)
  await git(['commit', '--allow-empty', '-m', 'root'], dir)
  if (options.remote !== undefined) await git(['remote', 'add', 'origin', options.remote], dir)
  if (options.originRef !== false && options.remote !== undefined) {
    await git(['update-ref', 'refs/remotes/origin/main', 'main'], dir)
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], dir)
  }
  if (options.branch !== undefined) {
    await git(['checkout', '-q', '-b', options.branch], dir)
    for (let index = 0; index < (options.ahead ?? 0); index += 1) {
      await git(['commit', '--allow-empty', '-m', `ahead ${index}`], dir)
    }
  }
  if (options.detached === true) {
    const sha = (await git(['rev-parse', 'HEAD'], dir)).trim()
    await git(['checkout', '-q', sha], dir)
  }
  return dir
}

interface Route {
  match: (url: string, method: string) => boolean
  respond: (body: string | undefined) => Response
}

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
}

/** Scripted fetch with recorded calls; unmatched URLs 404. */
function scriptedFetch(routes: Route[]): { fetch: typeof globalThis.fetch, calls: { url: string, method: string, body?: string }[] } {
  const calls: { url: string, method: string, body?: string }[] = []
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, ...body === undefined ? {} : { body } })
    if (init?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    const route = routes.find(candidate => candidate.match(url, method))
    return Promise.resolve(route !== undefined ? route.respond(body) : jsonResponse({ message: 'no route' }, 404))
  }
  return { fetch: fetchImpl, calls }
}

/** Sequenced responses for the token poll endpoint. */
function tokenSequence(bodies: unknown[]): Route {
  let index = 0
  return {
    match: url => url.includes('/login/oauth/access_token'),
    respond: () => jsonResponse(bodies[Math.min(index++, bodies.length - 1)]),
  }
}

const DEVICE_CODE_ROUTE: Route = {
  match: url => url.includes('/login/device/code'),
  respond: () => jsonResponse({
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 5,
    expires_in: 900,
  }),
}

function flowDeps(fetchImpl: typeof globalThis.fetch, overrides: Partial<DeviceFlowDeps> = {}): { deps: DeviceFlowDeps, updates: DeviceFlowUpdate[], sleeps: number[] } {
  const updates: DeviceFlowUpdate[] = []
  const sleeps: number[] = []
  const deps: DeviceFlowDeps = {
    fetch: fetchImpl,
    sleep: ms => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    authBaseURL: 'https://github.com/',
    clientId: 'client-1',
    scope: 'repo',
    onUpdate: update => updates.push(update),
    ...overrides,
  }
  return { deps, updates, sleeps }
}

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
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

function makeProvider(overrides: Partial<GitHubProvider> = {}): GitHubProvider {
  return {
    id: 'fake',
    available: () => true,
    search: () => Promise.reject(new Error('unused')),
    getIssue: () => Promise.reject(new Error('unused')),
    getPullRequest: () => Promise.reject(new Error('unused')),
    getComments: () => Promise.reject(new Error('unused')),
    getDiff: () => Promise.reject(new Error('unused')),
    getChecks: () => Promise.resolve({ runs: [{ name: 'ci', status: 'completed' as const, conclusion: 'success' as const }] }),
    createIssue: () => Promise.reject(new Error('unused')),
    createComment: () => Promise.reject(new Error('unused')),
    createPullRequest: request => Promise.resolve({
      pullRequest: {
        ref: { repo: request.repo, number: 5, url: 'https://x/pull/5' },
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

interface ServiceSuite {
  ctx: Context
  service: GitHubConnectService
  credentials: FakeCredentials
  flowStates: GitHubFlowState[]
  deviceUpdates: DeviceFlowUpdate[]
  credentialUpdates: string[]
  turnEnd(): Promise<void>
}

async function mountService(config: GitHubConnectConfig, options: { provider?: Partial<GitHubProvider>, credentials?: boolean } = {}): Promise<ServiceSuite> {
  const ctx = new Context()
  await ctx.plugin(GitHubRuntime)
  let credentials!: FakeCredentials
  if (options.credentials !== false) {
    await ctx.plugin(FakeCredentials)
    credentials = ctx.get('credentials') as FakeCredentials
  }
  ctx.github.registerProvider(makeProvider(options.provider))
  await ctx.plugin(GitHubConnectService, config)
  const service = ctx.githubConnect
  const flowStates: GitHubFlowState[] = []
  const deviceUpdates: DeviceFlowUpdate[] = []
  const credentialUpdates: string[] = []
  ctx.on('github/flow-state', state => void flowStates.push(state))
  ctx.on('github/device-flow', update => void deviceUpdates.push(update))
  ctx.on('credentials/updated', ref => void credentialUpdates.push(ref as string))
  let turn = 0
  return {
    ctx,
    service,
    credentials,
    flowStates,
    deviceUpdates,
    credentialUpdates,
    turnEnd: async () => {
      await ctx.serial('agent/turn-stopping', { agent: {} as never, turn: turn++, signal: new AbortController().signal })
    },
  }
}

// —— device flow (pure client) ————————————————————————————————————————————————

describe('device flow client', () => {
  it('requests a device code and applies pacing defaults when omitted', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([DEVICE_CODE_ROUTE])
    const { deps } = flowDeps(fetchImpl)
    const { prompt, deviceCode } = await requestDeviceCode(deps)
    expect(deviceCode).toBe('dev-1')
    expect(prompt).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 })
    expect(calls[0]!.url).toBe('https://github.com/login/device/code')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ client_id: 'client-1', scope: 'repo' })

    const bare = scriptedFetch([{
      match: url => url.includes('/login/device/code'),
      respond: () => jsonResponse({ device_code: 'd', user_code: 'u', verification_uri: 'v' }),
    }])
    const result = await requestDeviceCode(flowDeps(bare.fetch).deps)
    expect(result.prompt.interval).toBe(5)
    expect(result.prompt.expiresIn).toBe(900)
  })

  it.each([
    ['an unusable body', jsonResponse({ user_code: 'u' }), 'GITHUB_CONNECT_HTTP'],
    ['an HTTP failure', jsonResponse({}, 500), 'GITHUB_CONNECT_HTTP'],
  ])('refuses %s from the device code endpoint', async (_label, response, code) => {
    const { fetch: fetchImpl } = scriptedFetch([{ match: url => url.includes('/login/device/code'), respond: () => response }])
    await expect(requestDeviceCode(flowDeps(fetchImpl).deps)).rejects.toThrow(expect.objectContaining({ code }))
  })

  it('maps a transport failure and an abort distinctly', async () => {
    const failing: typeof globalThis.fetch = () => Promise.reject(new TypeError('offline'))
    await expect(requestDeviceCode(flowDeps(failing).deps))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_NETWORK' }))

    const controller = new AbortController()
    controller.abort()
    const { deps } = flowDeps(failing, { signal: controller.signal })
    await expect(requestDeviceCode(deps)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_ABORTED' }))
  })

  it('polls through pending to success at the server pace', async () => {
    const { fetch: fetchImpl } = scriptedFetch([tokenSequence([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'gho_token', token_type: 'bearer' },
    ])])
    const { deps, sleeps } = flowDeps(fetchImpl)
    await expect(pollForToken(deps, 'dev-1', 5)).resolves.toBe('gho_token')
    expect(sleeps).toEqual([5000, 5000, 5000])
  })

  it('adds five seconds and reports on slow_down', async () => {
    const { fetch: fetchImpl } = scriptedFetch([tokenSequence([
      { error: 'slow_down' },
      { access_token: 'gho_token' },
    ])])
    const { deps, sleeps, updates } = flowDeps(fetchImpl)
    await expect(pollForToken(deps, 'dev-1', 5)).resolves.toBe('gho_token')
    expect(sleeps).toEqual([5000, 10_000])
    expect(updates).toEqual([{ phase: 'slow-down', intervalSeconds: 10 }])
  })

  it.each([
    ['expired_token', 'GITHUB_CONNECT_EXPIRED'],
    ['access_denied', 'GITHUB_CONNECT_DENIED'],
    ['incorrect_client_credentials', 'GITHUB_CONNECT_HTTP'],
  ])('settles terminally on %s', async (error, code) => {
    const { fetch: fetchImpl } = scriptedFetch([tokenSequence([{ error }])])
    await expect(pollForToken(flowDeps(fetchImpl).deps, 'dev-1', 5)).rejects.toThrow(expect.objectContaining({ code }))
  })

  it('refuses a success response with no usable token', async () => {
    const { fetch: fetchImpl } = scriptedFetch([tokenSequence([{ access_token: '' }])])
    await expect(pollForToken(flowDeps(fetchImpl).deps, 'dev-1', 5)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_HTTP' }))
  })

  it('aborts between polls', async () => {
    const controller = new AbortController()
    const { fetch: fetchImpl } = scriptedFetch([tokenSequence([{ error: 'authorization_pending' }])])
    const { deps } = flowDeps(fetchImpl, {
      signal: controller.signal,
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
    })
    await expect(pollForToken(deps, 'dev-1', 5)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_ABORTED' }))
  })

  it('runs the whole flow, surfacing the prompt and the terminal phase', async () => {
    const { fetch: fetchImpl } = scriptedFetch([DEVICE_CODE_ROUTE, tokenSequence([{ access_token: 'gho_token' }])])
    const { deps, updates } = flowDeps(fetchImpl)
    const { token } = await runDeviceFlow(deps)
    expect(token).toBe('gho_token')
    expect(updates.map(update => update.phase)).toEqual(['awaiting-authorization', 'authorized'])

    const denied = scriptedFetch([DEVICE_CODE_ROUTE, tokenSequence([{ error: 'access_denied' }])])
    const run = flowDeps(denied.fetch)
    await expect(runDeviceFlow(run.deps)).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_DENIED' }))
    expect(run.updates.map(update => update.phase)).toEqual(['awaiting-authorization', 'denied'])
  })

  it('maps terminal failures to frontend phases', () => {
    expect(terminalUpdate(new GitHubError('x', 'GITHUB_CONNECT_EXPIRED'))).toEqual({ phase: 'expired' })
    expect(terminalUpdate(new GitHubError('x', 'GITHUB_CONNECT_DENIED'))).toEqual({ phase: 'denied' })
    expect(terminalUpdate(new Error('boom'))).toEqual({ phase: 'failed', message: 'boom' })
    expect(terminalUpdate('boom')).toEqual({ phase: 'failed', message: 'boom' })
  })
})

// —— flow-state detection on fixture repositories ————————————————————————————

const noPr = () => Promise.resolve(undefined)

function fixtureDeps(cwd: string, overrides: Partial<FlowStateDeps> = {}): FlowStateDeps {
  return {
    runGit: git,
    cwd,
    host: 'github.com',
    findOpenPr: noPr,
    findMergedPr: noPr,
    ...overrides,
  }
}

describe('flow-state detection (fixture repositories)', () => {
  it('hides without an origin remote, on a foreign remote, and on the base branch', async () => {
    expect((await detectFlowState(fixtureDeps(await makeRepo()))).state).toEqual({ kind: 'hidden' })
    expect((await detectFlowState(fixtureDeps(await makeRepo({ remote: 'https://gitlab.com/o/r.git' })))).state)
      .toEqual({ kind: 'hidden' })
    const onMain = await detectFlowState(fixtureDeps(await makeRepo({ remote: 'git@github.com:octo/hello-world.git' })))
    expect(onMain.state).toEqual({ kind: 'hidden' })
    expect(onMain.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('hides on a detached HEAD and on a non-ahead feature branch', async () => {
    const detached = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', detached: true })
    expect((await detectFlowState(fixtureDeps(detached))).state).toEqual({ kind: 'hidden' })
    const level = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 0 })
    expect((await detectFlowState(fixtureDeps(level))).state).toEqual({ kind: 'hidden' })
  })

  it('reports pr-ready when ahead with no PR (state 2)', async () => {
    const dir = await makeRepo({ remote: 'https://github.com/octo/hello-world.git', branch: 'feat/x', ahead: 2 })
    const { state, headSha } = await detectFlowState(fixtureDeps(dir))
    expect(state).toEqual({
      kind: 'pr-ready',
      repo: { owner: 'octo', repo: 'hello-world' },
      branch: 'feat/x',
      base: 'main',
      aheadCount: 2,
    })
    expect(headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('falls back to the local base ref when origin/main is absent', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1, originRef: false })
    const { state } = await detectFlowState(fixtureDeps(dir))
    expect(state).toMatchObject({ kind: 'pr-ready', aheadCount: 1, base: 'main' })
  })

  it('reports pr-open with CI rollup when the branch has an open PR (state 3)', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const { state } = await detectFlowState(fixtureDeps(dir, {
      findOpenPr: () => Promise.resolve({ number: 5, url: 'https://x/pull/5' }),
      checksSummary: () => Promise.resolve('passing' as const),
    }))
    expect(state).toEqual({
      kind: 'pr-open',
      repo: { owner: 'octo', repo: 'hello-world' },
      branch: 'feat/x',
      number: 5,
      url: 'https://x/pull/5',
      ci: 'passing',
    })
  })

  it('omits optional PR fields when unavailable', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const { state } = await detectFlowState(fixtureDeps(dir, {
      findOpenPr: () => Promise.resolve({ number: 5 }),
    }))
    expect(state).toEqual({
      kind: 'pr-open',
      repo: { owner: 'octo', repo: 'hello-world' },
      branch: 'feat/x',
      number: 5,
    })
  })

  it('reports pr-merged after the branch PR merged (state 4)', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const { state } = await detectFlowState(fixtureDeps(dir, {
      findMergedPr: () => Promise.resolve({ number: 5 }),
    }))
    expect(state).toEqual({
      kind: 'pr-merged',
      repo: { owner: 'octo', repo: 'hello-world' },
      branch: 'feat/x',
      number: 5,
    })
  })

  it('honors a configured base branch and folds lookup failures to hidden', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const overridden = await detectFlowState(fixtureDeps(dir, { baseBranch: 'feat/x' }))
    expect(overridden.state).toEqual({ kind: 'hidden' })
    const failing = await detectFlowState(fixtureDeps(dir, {
      findOpenPr: () => Promise.reject(new Error('offline')),
    }))
    expect(failing.state).toEqual({ kind: 'hidden' })
  })

  it('detects the base branch from origin/HEAD with a fallback to main', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git' })
    await expect(detectBaseBranch(git, dir)).resolves.toBe('main')
    const bare = await makeRepo()
    await expect(detectBaseBranch(git, bare)).resolves.toBe('main')
  })
})

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:octo/hello-world.git', { owner: 'octo', repo: 'hello-world' }],
    ['https://github.com/octo/hello-world.git', { owner: 'octo', repo: 'hello-world' }],
    ['https://github.com/octo/hello-world', { owner: 'octo', repo: 'hello-world' }],
    ['ssh://git@github.com/octo/hello-world.git', { owner: 'octo', repo: 'hello-world' }],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubRemote(url, 'github.com')).toEqual(expected)
  })

  it('rejects foreign hosts and unusable shapes, and honors a GHES host', () => {
    expect(parseGitHubRemote('https://gitlab.com/o/r.git', 'github.com')).toBeUndefined()
    expect(parseGitHubRemote('not a url', 'github.com')).toBeUndefined()
    expect(parseGitHubRemote('https://ghe.corp.example/o/r.git', 'ghe.corp.example')).toEqual({ owner: 'o', repo: 'r' })
  })
})

describe('summarizeChecks', () => {
  it('rolls check runs up into the badge state', () => {
    expect(summarizeChecks([])).toBeUndefined()
    expect(summarizeChecks([{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'success' }])).toBe('failing')
    expect(summarizeChecks([{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('passing')
  })
})

// —— the connect service ——————————————————————————————————————————————————————

describe('GitHubConnectService device flow', () => {
  it('requires a clientId and the credentials seam', async () => {
    const noClient = await mountService({})
    await expect(noClient.service.startDeviceFlow()).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_CONFIG' }))
    const noCredentials = await mountService({ clientId: 'c1' }, { credentials: false })
    await expect(noCredentials.service.startDeviceFlow()).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_CONFIG' }))
  })

  it('stores the token through the credentials seam and announces the update', async () => {
    const suite = await mountService({ clientId: 'c1' })
    const { fetch: fetchImpl } = scriptedFetch([
      DEVICE_CODE_ROUTE,
      tokenSequence([{ error: 'authorization_pending' }, { access_token: 'gho_fresh' }]),
    ])
    suite.service.fetchImpl = fetchImpl
    suite.service.sleep = () => Promise.resolve()
    const prompt = await suite.service.startDeviceFlow()
    expect(prompt.userCode).toBe('ABCD-1234')
    await suite.service.pendingFlow
    expect(suite.credentials.store.get('GITHUB_TOKEN')).toBe('gho_fresh')
    expect(suite.credentialUpdates).toEqual(['GITHUB_TOKEN'])
    expect(suite.deviceUpdates.map(update => update.phase)).toEqual(['awaiting-authorization', 'authorized'])
  })

  it('pushes the denied terminal phase', async () => {
    const suite = await mountService({ clientId: 'c1' })
    const { fetch: fetchImpl } = scriptedFetch([DEVICE_CODE_ROUTE, tokenSequence([{ error: 'access_denied' }])])
    suite.service.fetchImpl = fetchImpl
    suite.service.sleep = () => Promise.resolve()
    await suite.service.startDeviceFlow()
    await suite.service.pendingFlow
    expect(suite.deviceUpdates.map(update => update.phase)).toEqual(['awaiting-authorization', 'denied'])
    expect(suite.credentials.store.has('GITHUB_TOKEN')).toBe(false)
  })

  it('aborts a previous in-flight flow when a new one starts', async () => {
    const suite = await mountService({ clientId: 'c1' })
    const { fetch: fetchImpl } = scriptedFetch([
      DEVICE_CODE_ROUTE,
      tokenSequence([{ error: 'authorization_pending' }, { access_token: 'gho_second' }]),
    ])
    suite.service.fetchImpl = fetchImpl
    // The first flow parks in sleep until its signal aborts.
    suite.service.sleep = (_ms, signal) => new Promise(resolve => {
      if (signal?.aborted === true) resolve()
      else signal?.addEventListener('abort', () => resolve())
    })
    await suite.service.startDeviceFlow()
    const firstFlow = suite.service.pendingFlow
    suite.service.sleep = () => Promise.resolve()
    await suite.service.startDeviceFlow()
    await firstFlow
    await suite.service.pendingFlow
    // The aborted first flow's terminal update races the second flow's prompt;
    // only the multiset and the terminal grant are deterministic.
    expect(suite.deviceUpdates.map(update => update.phase).sort())
      .toEqual(['authorized', 'awaiting-authorization', 'awaiting-authorization', 'failed'])
    expect(suite.deviceUpdates.at(-1)!.phase).toBe('authorized')
    expect(suite.credentials.store.get('GITHUB_TOKEN')).toBe('gho_second')
  })

  it('aborts the active flow when the service disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(GitHubRuntime)
    await ctx.plugin(FakeCredentials)
    ctx.github.registerProvider(makeProvider())
    const fiber = await ctx.plugin(GitHubConnectService, { clientId: 'c1' })
    const service = ctx.githubConnect
    const { fetch: fetchImpl } = scriptedFetch([DEVICE_CODE_ROUTE, tokenSequence([{ error: 'authorization_pending' }])])
    service.fetchImpl = fetchImpl
    service.sleep = (_ms, signal) => new Promise(resolve => {
      if (signal?.aborted === true) resolve()
      else signal?.addEventListener('abort', () => resolve())
    })
    await service.startDeviceFlow()
    const pending = service.pendingFlow
    await fiber.dispose()
    await pending
  })
})

describe('GitHubConnectService connectStatus', () => {
  const userRoute = (login: unknown): Route => ({
    match: url => url.endsWith('/user'),
    respond: () => jsonResponse(login === undefined ? {} : { login }),
  })

  it('reports disconnected without a credential', async () => {
    const suite = await mountService({})
    await expect(suite.service.connectStatus()).resolves.toEqual({ connected: false })
  })

  it('resolves the login once and caches it per token', async () => {
    const suite = await mountService({})
    const { fetch: fetchImpl, calls } = scriptedFetch([userRoute('octocat')])
    suite.service.fetchImpl = fetchImpl
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(suite.service.connectStatus()).resolves.toEqual({ connected: true, login: 'octocat' })
    await expect(suite.service.connectStatus()).resolves.toEqual({ connected: true, login: 'octocat' })
    expect(calls).toHaveLength(1)
  })

  it('invalidates the cache when the SAME credential updates, and only then', async () => {
    const suite = await mountService({})
    const { fetch: fetchImpl, calls } = scriptedFetch([userRoute('octocat')])
    suite.service.fetchImpl = fetchImpl
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await suite.service.connectStatus()
    await suite.credentials.set('OTHER_REF' as CredentialRef, 'x')
    await suite.service.connectStatus()
    expect(calls).toHaveLength(1)
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_2')
    await suite.service.connectStatus()
    expect(calls).toHaveLength(2)
  })

  it('tolerates a login-less profile and maps a rejected credential to disconnected', async () => {
    const anonymous = await mountService({})
    const bare = scriptedFetch([userRoute(undefined)])
    anonymous.service.fetchImpl = bare.fetch
    await anonymous.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(anonymous.service.connectStatus()).resolves.toEqual({ connected: true })

    const rejected = await mountService({})
    rejected.service.fetchImpl = scriptedFetch([{ match: url => url.endsWith('/user'), respond: () => jsonResponse({}, 401) }]).fetch
    await rejected.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_bad')
    await expect(rejected.service.connectStatus()).resolves.toEqual({ connected: false })
  })

  it('propagates non-auth API failures', async () => {
    const suite = await mountService({})
    suite.service.fetchImpl = scriptedFetch([{ match: url => url.endsWith('/user'), respond: () => jsonResponse({}, 500) }]).fetch
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(suite.service.connectStatus()).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_HTTP' }))
  })
})

describe('GitHubConnectService flow-state over agent turns', () => {
  it('emits after a turn with new commits, gated on the credential, and collapses noise', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    suite.service.fetchImpl = scriptedFetch([{ match: url => url.includes('/pulls?'), respond: () => jsonResponse([]) }]).fetch

    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(0)

    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(1)
    expect(suite.flowStates[0]).toMatchObject({ kind: 'pr-ready', aheadCount: 1 })

    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(1)

    await git(['commit', '--allow-empty', '-m', 'more work'], dir)
    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(2)
    expect(suite.flowStates[1]).toMatchObject({ kind: 'pr-ready', aheadCount: 2 })
  })

  it('stays silent on a non-repository workspace and never breaks the turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-github-connect-empty-'))
    repos.push(dir)
    const suite = await mountService({ cwd: dir })
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(0)
  })

  it('walks open → merged through the branch PR lookup', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    let phase: 'open' | 'merged' = 'open'
    suite.service.fetchImpl = scriptedFetch([
      {
        match: url => url.includes('/pulls?') && url.includes('state=open'),
        respond: () => jsonResponse(phase === 'open' ? [{ number: 5, html_url: 'https://x/pull/5' }] : []),
      },
      {
        match: url => url.includes('/pulls?') && url.includes('state=closed'),
        respond: () => jsonResponse(phase === 'merged' ? [{ number: 5, merged_at: '2026-08-14T00:00:00Z' }] : []),
      },
    ]).fetch
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')

    await suite.turnEnd()
    expect(suite.flowStates[0]).toMatchObject({ kind: 'pr-open', number: 5, url: 'https://x/pull/5', ci: 'passing' })

    phase = 'merged'
    const merged = await suite.service.refreshFlowState()
    expect(merged).toMatchObject({ kind: 'pr-merged', number: 5 })
    expect(suite.flowStates[1]).toMatchObject({ kind: 'pr-merged' })
  })

  it('refreshFlowState reads hidden without a credential and does not emit it twice', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git' })
    const suite = await mountService({ cwd: dir })
    await expect(suite.service.refreshFlowState()).resolves.toEqual({ kind: 'hidden' })
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(suite.service.refreshFlowState()).resolves.toEqual({ kind: 'hidden' })
    expect(suite.flowStates).toHaveLength(0)
  })
})

describe('GitHubConnectService buttons', () => {
  it('creates a PR from the current branch through the seam', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const requests: unknown[] = []
    const suite = await mountService({ cwd: dir }, {
      provider: {
        createPullRequest: request => {
          requests.push(request)
          return Promise.resolve({
            pullRequest: {
              ref: { repo: request.repo, number: 5, url: 'https://x/pull/5' },
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
    const result = await suite.service.createPr({ title: 'Ship it', body: 'Summary' })
    expect(result).toEqual({ number: 5, created: true, head: 'feat/x', base: 'main', url: 'https://x/pull/5' })
    expect(requests[0]).toEqual({
      repo: { owner: 'octo', repo: 'hello-world' },
      title: 'Ship it',
      head: 'feat/x',
      base: 'main',
      body: 'Summary',
    })
  })

  it('honors a base override and omits an absent URL', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir }, {
      provider: {
        createPullRequest: request => Promise.resolve({
          pullRequest: {
            ref: { repo: request.repo, number: 6 },
            title: request.title,
            state: 'open' as const,
            baseRef: request.base,
            headRef: request.head,
          },
          created: false,
        }),
      },
    })
    const result = await suite.service.createPr({ title: 'T', base: 'develop' })
    expect(result).toEqual({ number: 6, created: false, head: 'feat/x', base: 'develop' })
  })

  it.each([
    ['a workspace without a repository', () => mkdtemp(join(tmpdir(), 'dsh-github-connect-x-'))],
    ['a non-GitHub remote', () => makeRepo({ remote: 'https://gitlab.com/o/r.git' })],
  ])('refuses the buttons on %s', async (_label, make) => {
    const dir = await make()
    repos.push(dir)
    const suite = await mountService({ cwd: dir })
    await expect(suite.service.createPr({ title: 'T' })).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_GIT' }))
  })

  it('merges with the chosen strategy', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    const { fetch: fetchImpl, calls } = scriptedFetch([{
      match: (url, method) => method === 'PUT' && url.includes('/pulls/5/merge'),
      respond: () => jsonResponse({ merged: true, sha: 'abc123' }),
    }])
    suite.service.fetchImpl = fetchImpl
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(suite.service.mergePr({ number: 5, method: 'squash' })).resolves.toEqual({ merged: true, sha: 'abc123' })
    expect(calls[0]!.url).toBe('https://api.github.com/repos/octo/hello-world/pulls/5/merge')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ merge_method: 'squash' })
  })

  it('maps merge refusals, auth absence, transport failures, and other HTTP failures', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    await expect(suite.service.mergePr({ number: 5, method: 'merge' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_AUTH' }))

    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    suite.service.fetchImpl = scriptedFetch([{
      match: (_url, method) => method === 'PUT',
      respond: () => new Response('{"message":"Pull Request is not mergeable"}', { status: 405 }),
    }]).fetch
    await expect(suite.service.mergePr({ number: 5, method: 'merge' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_MERGE_BLOCKED', message: expect.stringMatching(/not mergeable/) }))

    suite.service.fetchImpl = scriptedFetch([{
      match: (_url, method) => method === 'PUT',
      respond: () => new Response('conflict', { status: 409 }),
    }]).fetch
    await expect(suite.service.mergePr({ number: 5, method: 'rebase' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_MERGE_BLOCKED' }))

    suite.service.fetchImpl = scriptedFetch([{
      match: (_url, method) => method === 'PUT',
      respond: () => jsonResponse({}, 500),
    }]).fetch
    await expect(suite.service.mergePr({ number: 5, method: 'merge' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_HTTP' }))

    suite.service.fetchImpl = () => Promise.reject(new TypeError('offline'))
    await expect(suite.service.mergePr({ number: 5, method: 'merge' }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONNECT_NETWORK' }))
  })

  it('tolerates a merge reply without a sha', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    suite.service.fetchImpl = scriptedFetch([{
      match: (_url, method) => method === 'PUT',
      respond: () => jsonResponse({ merged: false }),
    }]).fetch
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await expect(suite.service.mergePr({ number: 5, method: 'merge' })).resolves.toEqual({ merged: false })
  })

  it('rolls up PR checks and reads unavailable checks as undefined', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    await expect(suite.service.prChecks(5)).resolves.toBe('passing')
    const failing = await mountService({ cwd: dir }, {
      provider: { getChecks: () => Promise.reject(new GitHubError('x', 'GITHUB_RATE_LIMITED')) },
    })
    await expect(failing.service.prChecks(5)).resolves.toBeUndefined()
  })

  it('disconnects by unsetting the credential, and no-ops without the seam', async () => {
    const suite = await mountService({})
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    await suite.service.disconnect()
    expect(suite.credentials.store.has('GITHUB_TOKEN')).toBe(false)

    const bare = await mountService({}, { credentials: false })
    await expect(bare.service.disconnect()).resolves.toBeUndefined()
  })
})

describe('coverage edges', () => {
  it('sleeps for the requested time and resolves early on abort', async () => {
    await defaultSleep(1)
    const controller = new AbortController()
    const parked = defaultSleep(60_000, controller.signal)
    controller.abort()
    await parked
  })

  it('forwards slow_down pacing updates through the service event', async () => {
    const suite = await mountService({ clientId: 'c1' })
    const { fetch: fetchImpl } = scriptedFetch([
      DEVICE_CODE_ROUTE,
      tokenSequence([{ error: 'slow_down' }, { access_token: 'gho_x' }]),
    ])
    suite.service.fetchImpl = fetchImpl
    suite.service.sleep = () => Promise.resolve()
    await suite.service.startDeviceFlow()
    await suite.service.pendingFlow
    expect(suite.deviceUpdates.map(update => update.phase))
      .toEqual(['awaiting-authorization', 'slow-down', 'authorized'])
  })

  it('falls back to the process environment when no credentials seam is mounted', async () => {
    const suite = await mountService({}, { credentials: false })
    const { fetch: fetchImpl } = scriptedFetch([{ match: url => url.endsWith('/user'), respond: () => jsonResponse({ login: 'octocat' }) }])
    suite.service.fetchImpl = fetchImpl
    try {
      process.env.GITHUB_TOKEN = ' env-tok '
      await expect(suite.service.connectStatus()).resolves.toEqual({ connected: true, login: 'octocat' })
      process.env.GITHUB_TOKEN = '   '
      await expect(suite.service.connectStatus()).resolves.toEqual({ connected: false })
      delete process.env.GITHUB_TOKEN
      await expect(suite.service.connectStatus()).resolves.toEqual({ connected: false })
    } finally {
      delete process.env.GITHUB_TOKEN
    }
  })

  it('reads a base ref without a slash as-is', async () => {
    await expect(detectBaseBranch(() => Promise.resolve('main\n'), '.')).resolves.toBe('main')
  })

  it('counts zero ahead when the base ref does not exist in any form', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 3 })
    const { state } = await detectFlowState(fixtureDeps(dir, { baseBranch: 'ghost' }))
    expect(state).toEqual({ kind: 'hidden' })
  })

  it('reads pr-ready even when the credential vanishes between the gate and the PR lookup', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    const { fetch: fetchImpl, calls } = scriptedFetch([])
    suite.service.fetchImpl = fetchImpl
    let resolves = 0
    const original = suite.credentials.resolve.bind(suite.credentials)
    suite.credentials.resolve = ref => (resolves++ === 0 ? original(ref) : Promise.resolve(undefined))
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    const state = await suite.service.refreshFlowState()
    expect(state).toMatchObject({ kind: 'pr-ready' })
    expect(calls).toHaveLength(0)
  })

  it('contains a throwing flow-state listener inside the turn hook', async () => {
    const dir = await makeRepo({ remote: 'git@github.com:octo/hello-world.git', branch: 'feat/x', ahead: 1 })
    const suite = await mountService({ cwd: dir })
    suite.service.fetchImpl = scriptedFetch([{ match: url => url.includes('/pulls?'), respond: () => jsonResponse([]) }]).fetch
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    suite.ctx.on('github/flow-state', () => {
      throw new Error('bad listener')
    })
    await suite.turnEnd()
    expect(suite.flowStates).toHaveLength(1)
  })

  it('defaults the workspace to the process cwd', async () => {
    const suite = await mountService({})
    suite.service.fetchImpl = scriptedFetch([{ match: url => url.includes('/pulls?'), respond: () => jsonResponse([]) }]).fetch
    await suite.credentials.set('GITHUB_TOKEN' as CredentialRef, 'gho_1')
    const state = await suite.service.refreshFlowState()
    expect(['hidden', 'pr-ready', 'pr-open', 'pr-merged']).toContain(state.kind)
  })
})

describe('dsh-github-connect invariant companion', () => {
  it('registers with the invariant service and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(connectInvariant.name).toBe('github-connect-invariant')
    expect(connectInvariant.inject).toEqual(['invariants'])
    const dispose = await connectInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
