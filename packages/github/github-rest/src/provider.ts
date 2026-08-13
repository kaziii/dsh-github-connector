/**
 * The REST v3 {@link GitHubProvider}: maps the v1 endpoint set onto the seam's
 * normalized vocabulary. Configuration and the credential are re-read on EVERY
 * operation (a changed token or base URL applies without restart), and
 * `createPullRequest` is idempotent per ADR-0004: look up the open PR first,
 * create only on a miss, and re-look-up once when the POST loses a race to a
 * concurrent creation (HTTP 422 "already exists").
 * @module dsh-github-rest/provider
 */

import type {
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentCreateRequest,
  GitHubDiff,
  GitHubDiffFile,
  GitHubDiffFileStatus,
  GitHubDiffRequest,
  GitHubIssue,
  GitHubIssueCreateRequest,
  GitHubItemRef,
  GitHubProvider,
  GitHubPullRequest,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestCreateResult,
  GitHubRepoRef,
  GitHubSearchItem,
  GitHubSearchKind,
  GitHubSearchRequest,
  GitHubSearchResult,
} from 'dsh-github'
import { GitHubError } from 'dsh-github'
import { buildUrl, restPaginate, restRequest, type RestTransport } from './http.ts'

/** The provider's stable registry id. */
export const PROVIDER_ID = 'rest'

/** Listing page size: the API maximum, minimizing requests per aggregation. */
const PAGE_SIZE = 100

/** Config snapshot one operation runs under, re-read from the source per call. */
export interface ResolvedRestConfig {
  /** Environment-variable name the token resolves through (default `GITHUB_TOKEN`). */
  readonly credentialRef: string
  /** API root, `https://api.github.com` or a GHES `/api/v3` root. */
  readonly baseURL: string
}

/** Wiring the provider receives from the plugin layer (or directly from tests). */
export interface RestGitHubProviderOptions {
  /** Current config; consulted at every operation, never cached here. */
  readonly config: () => ResolvedRestConfig
  /** Resolve the credential ref to a token, or undefined while unconfigured. */
  readonly resolveToken: (credentialRef: string) => Promise<string | undefined>
  /** Cheap, local, non-network answer to `available()` for the same ref. */
  readonly tokenConfigured: (credentialRef: string) => boolean
  /** Fetch implementation; defaults to the platform's. */
  readonly fetch?: typeof globalThis.fetch
}

/** Raw wire shapes — only the fields this provider reads. */
interface RawUser { readonly login: string }
interface RawLabel { readonly name?: string }
interface RawIssue {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly html_url?: string
  readonly body?: string | null
  readonly user?: RawUser | null
  readonly labels?: readonly (RawLabel | string)[]
  readonly created_at?: string
  readonly updated_at?: string
  readonly comments?: number
}
interface RawBranch { readonly ref: string, readonly sha: string }
interface RawPullRequest {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly merged_at?: string | null
  readonly html_url?: string
  readonly body?: string | null
  readonly user?: RawUser | null
  readonly draft?: boolean
  readonly base: RawBranch
  readonly head: RawBranch
  readonly created_at?: string
  readonly updated_at?: string
  readonly comments?: number
}
interface RawComment {
  readonly id: number
  readonly body: string
  readonly user?: RawUser | null
  readonly created_at?: string
  readonly html_url?: string
}
interface RawDiffFile {
  readonly filename: string
  readonly previous_filename?: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly patch?: string
}
interface RawCheckRun {
  readonly name: string
  readonly status: 'queued' | 'in_progress' | 'completed'
  readonly conclusion?: GitHubChecksResult['runs'][number]['conclusion'] | null
  readonly html_url?: string | null
}
interface RawCheckRuns { readonly check_runs: readonly RawCheckRun[] }
interface RawSearchIssue extends RawIssue {
  readonly repository_url?: string
  readonly pull_request?: { readonly merged_at?: string | null }
}
interface RawSearchRepo {
  readonly full_name: string
  readonly html_url: string
  readonly description?: string | null
}
interface RawSearchCode {
  readonly path: string
  readonly html_url: string
  readonly repository: { readonly full_name: string }
}
interface RawSearchResponse { readonly total_count: number, readonly items: readonly unknown[] }

/** Search endpoint per kind; issues and pull requests share `/search/issues`. */
const SEARCH_PATH: Record<GitHubSearchKind, string> = {
  'issues': '/search/issues',
  'pull-requests': '/search/issues',
  'repositories': '/search/repositories',
  'code': '/search/code',
}

/** Qualifier appended to the query so the shared issue endpoint filters by kind. */
const SEARCH_QUALIFIER: Record<GitHubSearchKind, string> = {
  'issues': ' is:issue',
  'pull-requests': ' is:pr',
  'repositories': '',
  'code': '',
}

/** Diff statuses the seam vocabulary knows; anything the API adds later degrades to `changed`. */
const FILE_STATUSES: ReadonlySet<string> = new Set<GitHubDiffFileStatus>([
  'added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged',
])

/** Spread helper: include `key` only when `value` is neither null nor undefined. */
function optional<K extends string, V>(key: K, value: V | null | undefined): { readonly [P in K]?: V } {
  return (value == null ? {} : { [key]: value }) as { readonly [P in K]?: V }
}

/** Parse `owner/repo` out of a `…/repos/{owner}/{repo}` API URL, or undefined. */
function repoFromApiUrl(url: string | undefined): GitHubRepoRef | undefined {
  const match = url === undefined ? null : /\/repos\/([^/]+)\/([^/]+)$/.exec(url)
  return match === null ? undefined : { owner: match[1]!, repo: match[2]! }
}

/** Parse an `owner/repo` full name, or undefined when it is not exactly two segments. */
function repoFromFullName(fullName: string): GitHubRepoRef | undefined {
  const match = /^([^/]+)\/([^/]+)$/.exec(fullName)
  return match === null ? undefined : { owner: match[1]!, repo: match[2]! }
}

/** Normalize label entries: the API returns objects (occasionally bare strings); nameless entries drop. */
function labelNames(labels: readonly (RawLabel | string)[]): readonly string[] {
  return labels
    .map(label => typeof label === 'string' ? label : label.name)
    .filter((name): name is string => name !== undefined)
}

function mapIssue(repo: GitHubRepoRef, raw: RawIssue): GitHubIssue {
  return {
    ref: { repo, number: raw.number, ...optional('url', raw.html_url) },
    title: raw.title,
    state: raw.state === 'closed' ? 'closed' : 'open',
    ...optional('body', raw.body),
    ...optional('author', raw.user?.login),
    ...raw.labels === undefined ? {} : { labels: labelNames(raw.labels) },
    ...optional('createdAt', raw.created_at),
    ...optional('updatedAt', raw.updated_at),
    ...optional('commentCount', raw.comments),
  }
}

function mapPullRequest(repo: GitHubRepoRef, raw: RawPullRequest): GitHubPullRequest {
  return {
    ref: { repo, number: raw.number, ...optional('url', raw.html_url) },
    title: raw.title,
    state: raw.merged_at != null ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    baseRef: raw.base.ref,
    headRef: raw.head.ref,
    ...optional('body', raw.body),
    ...optional('author', raw.user?.login),
    ...optional('draft', raw.draft),
    ...optional('createdAt', raw.created_at),
    ...optional('updatedAt', raw.updated_at),
    ...optional('commentCount', raw.comments),
  }
}

function mapComment(raw: RawComment): GitHubComment {
  return {
    id: raw.id,
    body: raw.body,
    ...optional('author', raw.user?.login),
    ...optional('createdAt', raw.created_at),
    ...optional('url', raw.html_url),
  }
}

function mapDiffFile(raw: RawDiffFile): GitHubDiffFile {
  return {
    path: raw.filename,
    ...optional('previousPath', raw.previous_filename),
    status: FILE_STATUSES.has(raw.status) ? raw.status as GitHubDiffFileStatus : 'changed',
    additions: raw.additions,
    deletions: raw.deletions,
    ...optional('patch', raw.patch),
  }
}

function mapSearchItem(kind: GitHubSearchKind, raw: unknown): GitHubSearchItem {
  switch (kind) {
    case 'issues':
    case 'pull-requests': {
      const item = raw as RawSearchIssue
      return {
        title: item.title,
        url: item.html_url ?? '',
        ...optional('repo', repoFromApiUrl(item.repository_url)),
        number: item.number,
        state: item.pull_request?.merged_at != null ? 'merged' : item.state,
      }
    }
    case 'repositories': {
      const item = raw as RawSearchRepo
      return {
        title: item.full_name,
        url: item.html_url,
        ...optional('repo', repoFromFullName(item.full_name)),
        ...optional('snippet', item.description),
      }
    }
    case 'code': {
      const item = raw as RawSearchCode
      return {
        title: item.path,
        url: item.html_url,
        ...optional('repo', repoFromFullName(item.repository.full_name)),
      }
    }
  }
}

/**
 * The REST v3 provider. Owns ALL seam operations under one identity and
 * credential (ADR-0003); never retries rate limits (the caller decides).
 */
export class RestGitHubProvider implements GitHubProvider {
  readonly id = PROVIDER_ID
  private readonly options: RestGitHubProviderOptions
  private readonly fetch: typeof globalThis.fetch

  constructor(options: RestGitHubProviderOptions) {
    this.options = options
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** Cheap local check only — no network (seam contract). */
  available(): boolean {
    return this.options.tokenConfigured(this.options.config().credentialRef)
  }

  async search(request: GitHubSearchRequest, signal?: AbortSignal): Promise<GitHubSearchResult> {
    const transport = await this.transport()
    const url = buildUrl(transport.baseURL, SEARCH_PATH[request.kind], {
      q: request.query + SEARCH_QUALIFIER[request.kind],
      ...request.maxResults === undefined ? {} : { per_page: Math.min(request.maxResults, PAGE_SIZE) },
    })
    const { json } = await restRequest(transport, url, { signal })
    const response = json as RawSearchResponse
    return {
      items: response.items.map(item => mapSearchItem(request.kind, item)),
      truncated: response.total_count > response.items.length,
    }
  }

  async getIssue(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubIssue> {
    const transport = await this.transport()
    const { json } = await restRequest(transport, this.itemUrl(transport, item, 'issues'), { signal })
    return mapIssue(item.repo, json as RawIssue)
  }

  async getPullRequest(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubPullRequest> {
    const transport = await this.transport()
    const { json } = await restRequest(transport, this.itemUrl(transport, item, 'pulls'), { signal })
    return mapPullRequest(item.repo, json as RawPullRequest)
  }

  async getComments(item: GitHubItemRef, signal?: AbortSignal): Promise<readonly GitHubComment[]> {
    const transport = await this.transport()
    const first = buildUrl(transport.baseURL, `${repoPath(item.repo)}/issues/${item.number}/comments`, { per_page: PAGE_SIZE })
    const { items } = await restPaginate(transport, first, json => (json as readonly RawComment[]), { signal })
    return items.map(mapComment)
  }

  async getDiff(item: GitHubItemRef, request: GitHubDiffRequest, signal?: AbortSignal): Promise<GitHubDiff> {
    const transport = await this.transport()
    const first = buildUrl(transport.baseURL, `${repoPath(item.repo)}/pulls/${item.number}/files`, { per_page: PAGE_SIZE })
    const { items, exhausted } = await restPaginate(
      transport,
      first,
      json => (json as readonly RawDiffFile[]),
      { signal },
      // maxFiles is satisfiable early: later pages stay unfetched (ADR-0005
      // lets the provider optimize; the seam still enforces the budget).
      files => request.maxFiles !== undefined && files.length >= request.maxFiles,
    )
    return { files: items.map(mapDiffFile), truncated: !exhausted }
  }

  async getChecks(item: GitHubItemRef, signal?: AbortSignal): Promise<GitHubChecksResult> {
    const transport = await this.transport()
    const { json } = await restRequest(transport, this.itemUrl(transport, item, 'pulls'), { signal })
    const sha = (json as RawPullRequest).head.sha
    const first = buildUrl(transport.baseURL, `${repoPath(item.repo)}/commits/${sha}/check-runs`, { per_page: PAGE_SIZE })
    const { items } = await restPaginate(transport, first, page => (page as RawCheckRuns).check_runs, { signal })
    return {
      runs: items.map(raw => ({
        name: raw.name,
        status: raw.status,
        ...optional('conclusion', raw.conclusion),
        ...optional('url', raw.html_url),
      })),
    }
  }

  async createIssue(request: GitHubIssueCreateRequest, signal?: AbortSignal): Promise<GitHubIssue> {
    const transport = await this.transport()
    const { json } = await restRequest(transport, buildUrl(transport.baseURL, `${repoPath(request.repo)}/issues`), {
      method: 'POST',
      body: {
        title: request.title,
        ...optional('body', request.body),
        ...optional('labels', request.labels),
      },
      signal,
    })
    return mapIssue(request.repo, json as RawIssue)
  }

  async createComment(request: GitHubCommentCreateRequest, signal?: AbortSignal): Promise<GitHubComment> {
    const transport = await this.transport()
    const url = buildUrl(transport.baseURL, `${repoPath(request.item.repo)}/issues/${request.item.number}/comments`)
    const { json } = await restRequest(transport, url, { method: 'POST', body: { body: request.body }, signal })
    return mapComment(json as RawComment)
  }

  async createPullRequest(request: GitHubPullRequestCreateRequest, signal?: AbortSignal): Promise<GitHubPullRequestCreateResult> {
    const transport = await this.transport()
    const existing = await this.findOpenPullRequest(transport, request, signal)
    if (existing !== undefined) return { pullRequest: existing, created: false }
    try {
      const { json } = await restRequest(transport, buildUrl(transport.baseURL, `${repoPath(request.repo)}/pulls`), {
        method: 'POST',
        body: {
          title: request.title,
          head: request.head,
          base: request.base,
          ...optional('body', request.body),
          ...optional('draft', request.draft),
        },
        signal,
      })
      return { pullRequest: mapPullRequest(request.repo, json as RawPullRequest), created: true }
    } catch (error) {
      // Race fallback (ADR-0004): a concurrent creation between our lookup and
      // POST surfaces as 422 "already exists" — resolve it to the winner's PR.
      if (error instanceof GitHubError && error.code === 'GITHUB_VALIDATION' && /already exists/i.test(error.message)) {
        const raced = await this.findOpenPullRequest(transport, request, signal)
        if (raced !== undefined) return { pullRequest: raced, created: false }
      }
      throw error
    }
  }

  /** Look up the open PR for the exact head/base pair, or undefined. */
  private async findOpenPullRequest(
    transport: RestTransport,
    request: GitHubPullRequestCreateRequest,
    signal: AbortSignal | undefined,
  ): Promise<GitHubPullRequest | undefined> {
    const url = buildUrl(transport.baseURL, `${repoPath(request.repo)}/pulls`, {
      head: `${request.repo.owner}:${request.head}`,
      base: request.base,
      state: 'open',
      per_page: 1,
    })
    const { json } = await restRequest(transport, url, { signal })
    const [first] = json as readonly RawPullRequest[]
    return first === undefined ? undefined : mapPullRequest(request.repo, first)
  }

  /** URL of one issue/PR read; both families share the `/{collection}/{number}` shape. */
  private itemUrl(transport: RestTransport, item: GitHubItemRef, collection: 'issues' | 'pulls'): string {
    return buildUrl(transport.baseURL, `${repoPath(item.repo)}/${collection}/${item.number}`)
  }

  /**
   * Assemble the transport for ONE operation: config and credential are
   * resolved fresh here, which is the seam's change-without-restart guarantee.
   */
  private async transport(): Promise<RestTransport> {
    const { credentialRef, baseURL } = this.options.config()
    const token = await this.options.resolveToken(credentialRef)
    if (token === undefined) {
      throw new GitHubError(`GitHub credential "${credentialRef}" is not configured; set it or connect GitHub`, 'GITHUB_AUTH')
    }
    return { baseURL, token, fetch: this.fetch }
  }
}

/** Escaped `/repos/{owner}/{repo}` path segment pair. */
function repoPath(repo: GitHubRepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}
