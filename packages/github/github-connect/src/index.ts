/**
 * The GitHub connect service (`ctx.githubConnect`): Device Flow authorization
 * that stores the token through the credentials seam (ADR-0001), deterministic
 * git flow-state detection pushed over `github/flow-state` after each agent
 * turn (ADR-0002), and `@Remote` methods the web UI's buttons call directly —
 * zero model turns (design §6). Gating: a non-GitHub remote or an unresolvable
 * credential emits nothing, so unconnected users never see the feature.
 * @module dsh-github-connect
 */

import { execFile } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent'
import { GitHubError, type GitHubRepoRef } from 'dsh-github'
import {
  pollForToken,
  requestDeviceCode,
  terminalUpdate,
  type DeviceFlowDeps,
  type DeviceFlowPrompt,
  type DeviceFlowUpdate,
} from './device-flow.ts'
import {
  detectBaseBranch,
  detectFlowState,
  parseGitHubRemote,
  summarizeChecks,
  type BranchPullRequest,
  type ChecksSummary,
  type FlowStateDeps,
  type GitHubFlowState,
} from './flow-state.ts'

export {
  pollForToken,
  requestDeviceCode,
  runDeviceFlow,
  terminalUpdate,
  type DeviceFlowDeps,
  type DeviceFlowPrompt,
  type DeviceFlowUpdate,
} from './device-flow.ts'
export {
  detectBaseBranch,
  detectFlowState,
  parseGitHubRemote,
  summarizeChecks,
  type BranchPullRequest,
  type ChecksSummary,
  type FlowStateDeps,
  type FlowStateSnapshot,
  type GitHubFlowState,
} from './flow-state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    githubConnect: GitHubConnectService
  }
  interface Events {
    /**
     * The conversation PR status bar's state changed (design §2). Emitted only
     * for connected users on a GitHub-remoted workspace, after agent turns
     * that produced new commits, and from explicit UI refreshes.
     * @param state - the four-state machine's current state.
     * @mode emit
     */
    'github/flow-state'(state: GitHubFlowState): void
    /**
     * Device Flow progress for the settings UI: the prompt to show, pacing
     * changes, and the terminal phase.
     * @param update - the progress update.
     * @mode emit
     */
    'github/device-flow'(update: DeviceFlowUpdate): void
  }
}

/** Plugin config. Only `clientId` has no default; it gates the Device Flow. */
export interface GitHubConnectConfig {
  /** GitHub OAuth App client id; Device Flow is unavailable without it. */
  clientId?: string
  /** Credential reference the token is stored under and resolved from. */
  credentialRef?: string
  /** REST root (GHES: `https://ghes.example.com/api/v3`). */
  apiBaseURL?: string
  /** OAuth host (NOT the API host). */
  authBaseURL?: string
  /** GitHub host a workspace remote must point at to activate flow-state. */
  host?: string
  /** Workspace directory for git checks; defaults to the process cwd. */
  cwd?: string
  /** Base branch override; otherwise the remote HEAD (falling back to `main`). */
  baseBranch?: string
  /** OAuth scope requested by the Device Flow. */
  scope?: string
}

/** Config with schema defaults applied. */
interface ResolvedConnectConfig extends GitHubConnectConfig {
  credentialRef: string
  apiBaseURL: string
  authBaseURL: string
  host: string
  scope: string
}

/** Outcome of a `createPr` button press. */
export interface CreatePrResult {
  readonly number: number
  readonly url?: string
  /** False when an open PR for the branch already existed (ADR-0004). */
  readonly created: boolean
  readonly head: string
  readonly base: string
}

/** Merge strategies of the Merge dropdown (design §1). */
export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** Run one git command via execFile, resolving trimmed-newline stdout. */
function execGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args as string[], { cwd, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/** Abortable timer used between Device Flow polls (the service's default `sleep`). */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

/**
 * The connect service. `@Remote` methods are the web UI's direct lines
 * (Typert Gateway discovers them through the {@link TypertRemoteService}
 * binding); everything else is host-internal.
 */
export class GitHubConnectService extends TypertRemoteService {
  static inject = ['github']

  /** Config schema (see {@link GitHubConnectConfig} for field semantics). */
  static Config: z<GitHubConnectConfig> = z.object({
    clientId: z.string(),
    credentialRef: z.string().default('GITHUB_TOKEN'),
    apiBaseURL: z.string().default('https://api.github.com'),
    authBaseURL: z.string().default('https://github.com'),
    host: z.string().default('github.com'),
    cwd: z.string(),
    baseBranch: z.string(),
    scope: z.string().default('repo'),
  })

  readonly config: ResolvedConnectConfig

  /** Injectable transport (tests replace with scripted fetches). */
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
  /** Injectable poll timer (tests replace with an immediate resolve). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep
  /** Injectable git runner (fixture repos use the real one in a temp cwd). */
  runGit: (args: readonly string[], cwd: string) => Promise<string> = execGit

  /** The in-flight Device Flow poll, exposed so callers/tests can await settlement. */
  pendingFlow: Promise<void> | undefined

  private activeFlow: AbortController | undefined
  private lastFlowUpdate: DeviceFlowUpdate | undefined
  private lastHead: string | undefined
  private lastEmitted: GitHubFlowState['kind'] = 'hidden'
  private statusCache: { token: string, login: string } | undefined

  constructor(ctx: Context, config: GitHubConnectConfig = {}) {
    super(ctx, 'githubConnect')
    this.config = config as ResolvedConnectConfig
    ctx.on('agent/turn-stopping', () => this.onTurnEnd())
    ctx.on('credentials/updated', ref => {
      if ((ref as string) === this.config.credentialRef) this.statusCache = undefined
    })
    ctx.effect(() => () => this.activeFlow?.abort(), 'githubConnect.abortDeviceFlow')
  }

  /**
   * Whether a usable credential exists, and who it authenticates as. The
   * login lookup is cached per token and invalidated by `credentials/updated`.
   * @returns the connection state for the settings section.
   */
  @Remote
  async connectStatus(): Promise<{ connected: boolean, login?: string }> {
    const token = await this.resolveToken()
    if (token === undefined) return { connected: false }
    if (this.statusCache !== undefined && this.statusCache.token === token) {
      return { connected: true, login: this.statusCache.login }
    }
    try {
      const user = await this.api(token, 'GET', '/user') as { login?: unknown }
      if (typeof user.login !== 'string') return { connected: true }
      this.statusCache = { token, login: user.login }
      return { connected: true, login: user.login }
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'GITHUB_AUTH') return { connected: false }
      throw error
    }
  }

  /**
   * Begin one Device Flow: returns the user prompt immediately and keeps
   * polling in the background, pushing progress over `github/device-flow`.
   * On success the token lands in the credentials seam, whose
   * `credentials/updated` event refreshes every consumer — no restart.
   * A new start aborts any previous in-flight flow.
   * @returns the code and URL the frontend shows (and auto-copies).
   */
  @Remote
  async startDeviceFlow(): Promise<DeviceFlowPrompt> {
    const clientId = this.config.clientId
    if (clientId === undefined) {
      throw new GitHubError('no GitHub OAuth clientId is configured for the device flow', 'GITHUB_CONNECT_CONFIG')
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new GitHubError('the credentials seam is required to store the GitHub token', 'GITHUB_CONNECT_CONFIG')
    }
    this.activeFlow?.abort()
    const controller = new AbortController()
    this.activeFlow = controller
    this.lastFlowUpdate = undefined
    const deps: DeviceFlowDeps = {
      fetch: this.fetchImpl,
      sleep: this.sleep,
      authBaseURL: this.config.authBaseURL,
      clientId,
      scope: this.config.scope,
      signal: controller.signal,
      onUpdate: update => this.pushFlowUpdate(controller, update),
    }
    const { prompt, deviceCode } = await requestDeviceCode(deps)
    this.pushFlowUpdate(controller, { phase: 'awaiting-authorization', prompt })
    this.pendingFlow = pollForToken(deps, deviceCode, prompt.interval)
      .then(async token => {
        await credentials.set(credentialRef(this.config.credentialRef), token)
        this.pushFlowUpdate(controller, { phase: 'authorized' })
      })
      .catch((error: unknown) => {
        this.pushFlowUpdate(controller, terminalUpdate(error))
      })
    return prompt
  }

  /**
   * The latest Device Flow progress — the settings card's polling source
   * (ADR-0009: dsh does not forward custom host events to the browser, so the
   * frontend polls this instead of subscribing to `github/device-flow`).
   * @returns the last update of the active flow, or undefined before any flow.
   */
  @Remote
  deviceFlowStatus(): DeviceFlowUpdate | undefined {
    return this.lastFlowUpdate
  }

  /** Record progress for {@link deviceFlowStatus} and emit the host-internal event, dropping updates from a superseded flow. */
  private pushFlowUpdate(flow: AbortController, update: DeviceFlowUpdate): void {
    if (this.activeFlow !== flow) return
    this.lastFlowUpdate = update
    this.ctx.emit('github/device-flow', update)
  }

  /**
   * Forget the stored credential (the settings section's Disconnect button).
   */
  @Remote
  async disconnect(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return
    await credentials.unset(credentialRef(this.config.credentialRef))
    this.statusCache = undefined
  }

  /**
   * Create a PR from the workspace's current branch — the status bar's
   * [Create PR] button. Title/body arrive prefilled by the host and edited by
   * the user; the branch and base come from git. Idempotent through the seam
   * (ADR-0004).
   * @param request - title, optional body, optional base override.
   * @returns the created-or-existing PR and the branches used.
   */
  @Remote
  async createPr(request: { title: string, body?: string, base?: string }): Promise<CreatePrResult> {
    const facts = await this.repoFacts()
    const base = request.base ?? facts.base
    const result = await this.ctx.github.createPullRequest({
      repo: facts.repo,
      title: request.title,
      head: facts.branch,
      base,
      ...request.body === undefined ? {} : { body: request.body },
    })
    return {
      number: result.pullRequest.ref.number,
      created: result.created,
      head: facts.branch,
      base,
      ...result.pullRequest.ref.url === undefined ? {} : { url: result.pullRequest.ref.url },
    }
  }

  /**
   * Merge one PR — the status bar's [Merge] dropdown, behind the host's
   * irreversible-action confirmation.
   * @param request - the PR number and merge strategy.
   * @returns GitHub's merge outcome.
   */
  @Remote
  async mergePr(request: { number: number, method: MergeMethod }): Promise<{ merged: boolean, sha?: string }> {
    const facts = await this.repoFacts()
    const token = await this.requireToken()
    const path = `/repos/${encodeURIComponent(facts.repo.owner)}/${encodeURIComponent(facts.repo.repo)}/pulls/${request.number}/merge`
    const json = await this.api(token, 'PUT', path, { merge_method: request.method }) as { merged?: unknown, sha?: unknown }
    return {
      merged: json.merged === true,
      ...typeof json.sha === 'string' ? { sha: json.sha } : {},
    }
  }

  /**
   * CI rollup for one PR — the badge poller's endpoint. The frontend owns the
   * cadence: poll with backoff and STOP while the page is hidden (risk table).
   * @param number - the PR number.
   * @returns the rollup, or undefined when checks are unavailable.
   */
  @Remote
  async prChecks(number: number): Promise<ChecksSummary | undefined> {
    const facts = await this.repoFacts()
    return this.checksSummary(facts.repo, number)
  }

  /**
   * Re-detect the flow state on demand (UI refresh after its own button
   * actions), bypassing the new-commits noise rule, and emit the result.
   * @returns the freshly detected state.
   */
  @Remote
  async refreshFlowState(): Promise<GitHubFlowState> {
    if (await this.resolveToken() === undefined) return { kind: 'hidden' }
    const snapshot = await detectFlowState(this.flowDeps())
    if (snapshot.headSha !== undefined) this.lastHead = snapshot.headSha
    this.emitState(snapshot.state)
    return snapshot.state
  }

  /**
   * Turn-end hook (ADR-0002): gated on a resolvable credential, skipped when
   * the turn produced no new commits, and NEVER allowed to break the turn.
   */
  private async onTurnEnd(): Promise<void> {
    try {
      if (await this.resolveToken() === undefined) return
      let head: string
      try {
        head = (await this.runGit(['rev-parse', 'HEAD'], this.cwd())).trim()
      } catch {
        return
      }
      if (head === this.lastHead) return
      this.lastHead = head
      const snapshot = await detectFlowState(this.flowDeps())
      this.emitState(snapshot.state)
    } catch {
      // Detection is best-effort; a turn must never fail because of it.
    }
  }

  /** Emit a state change, collapsing repeated hides (unconnected users see nothing). */
  private emitState(state: GitHubFlowState): void {
    if (state.kind === 'hidden' && this.lastEmitted === 'hidden') return
    this.lastEmitted = state.kind
    this.ctx.emit('github/flow-state', state)
  }

  /** Assemble the injected detection dependencies. */
  private flowDeps(): FlowStateDeps {
    return {
      runGit: this.runGit,
      cwd: this.cwd(),
      host: this.config.host,
      baseBranch: this.config.baseBranch,
      findOpenPr: (repo, branch) => this.findBranchPr(repo, branch, 'open'),
      findMergedPr: (repo, branch) => this.findBranchPr(repo, branch, 'closed'),
      checksSummary: (repo, number) => this.checksSummary(repo, number),
    }
  }

  /** CI rollup through the seam; any failure (no provider, rate limit) reads as unavailable. */
  private async checksSummary(repo: GitHubRepoRef, number: number): Promise<ChecksSummary | undefined> {
    try {
      const checks = await this.ctx.github.getChecks({ repo, number })
      return summarizeChecks(checks.runs)
    } catch {
      return undefined
    }
  }

  /** Look up the branch's PR by exact head, host-side (not a seam operation). */
  private async findBranchPr(repo: GitHubRepoRef, branch: string, state: 'open' | 'closed'): Promise<BranchPullRequest | undefined> {
    const token = await this.resolveToken()
    if (token === undefined) return undefined
    const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`
      + `?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=${state}&per_page=5`
    const json = await this.api(token, 'GET', path) as readonly { number: number, html_url?: string, merged_at?: string | null }[]
    const hit = state === 'open' ? json[0] : json.find(pr => pr.merged_at != null)
    if (hit === undefined) return undefined
    return { number: hit.number, ...hit.html_url === undefined ? {} : { url: hit.html_url } }
  }

  /** The workspace's repo/branch/base facts, or a typed refusal for the buttons. */
  private async repoFacts(): Promise<{ repo: GitHubRepoRef, branch: string, base: string }> {
    const cwd = this.cwd()
    let remote: string
    try {
      remote = await this.runGit(['remote', 'get-url', 'origin'], cwd)
    } catch (cause) {
      throw new GitHubError('the workspace is not a git repository with an origin remote', 'GITHUB_CONNECT_GIT', { cause })
    }
    const repo = parseGitHubRemote(remote, this.config.host)
    if (repo === undefined) {
      throw new GitHubError(`the origin remote does not point at ${this.config.host}`, 'GITHUB_CONNECT_GIT')
    }
    const branch = (await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    const base = this.config.baseBranch ?? await detectBaseBranch(this.runGit, cwd)
    return { repo, branch, base }
  }

  private cwd(): string {
    return this.config.cwd ?? process.cwd()
  }

  /** Resolve the credential: seam first, process environment as the fallback. */
  private async resolveToken(): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef(this.config.credentialRef))
      if (resolved !== undefined) return resolved.value
    }
    const value = process.env[this.config.credentialRef]
    const trimmed = value === undefined ? '' : value.trim()
    return trimmed === '' ? undefined : trimmed
  }

  /** Resolve the credential or throw the auth refusal the buttons surface. */
  private async requireToken(): Promise<string> {
    const token = await this.resolveToken()
    if (token === undefined) {
      throw new GitHubError(`GitHub credential "${this.config.credentialRef}" is not configured; connect GitHub first`, 'GITHUB_AUTH')
    }
    return token
  }

  /** One authenticated REST call against the API host, with connect-scoped error mapping. */
  private async api(token: string, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.config.apiBaseURL.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          'accept': 'application/vnd.github+json',
          'authorization': `Bearer ${token}`,
          'user-agent': 'dsh-github-connect',
          'x-github-api-version': '2022-11-28',
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
    } catch (cause) {
      throw new GitHubError(`GitHub request ${method} ${path} failed before a response arrived`, 'GITHUB_CONNECT_NETWORK', { cause })
    }
    if (response.status === 401) {
      throw new GitHubError('GitHub rejected the credential (HTTP 401)', 'GITHUB_AUTH')
    }
    if (response.status === 405 || response.status === 409) {
      const detail = await this.apiMessage(response)
      throw new GitHubError(`GitHub refused the operation (HTTP ${response.status})${detail}`, 'GITHUB_MERGE_BLOCKED')
    }
    if (!response.ok) {
      const detail = await this.apiMessage(response)
      throw new GitHubError(`GitHub request ${method} ${path} failed with HTTP ${response.status}${detail}`, 'GITHUB_CONNECT_HTTP')
    }
    return response.json()
  }

  /** Extract the API's diagnostic suffix from an error body, tolerating non-JSON. */
  private async apiMessage(response: Response): Promise<string> {
    try {
      const parsed: unknown = JSON.parse(await response.text())
      if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string') {
        return `: ${parsed.message}`
      }
    } catch {
      // Non-JSON body — no suffix.
    }
    return ''
  }
}

export default GitHubConnectService
