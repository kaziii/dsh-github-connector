/**
 * REST transport core for `dsh-github-rest`: URL composition (github.com and
 * GHES bases), authenticated JSON requests over platform `fetch` (ADR-0006),
 * Link-header pagination with a hard page cap, and the single mapping from
 * HTTP outcomes to the seam's {@link GitHubError} vocabulary. Rate limits map
 * to `GITHUB_RATE_LIMITED { retryAfterMs }` and are NEVER retried here — the
 * seam contract hands that decision to the caller.
 * @module dsh-github-rest/http
 */

import { GitHubError } from 'dsh-github'

/** Everything one request needs; assembled per operation so credential and base changes apply live. */
export interface RestTransport {
  /** API root: `https://api.github.com`, or a GHES root such as `https://ghe.example.com/api/v3`. */
  readonly baseURL: string
  /** The resolved token, sent as a `Bearer` credential. */
  readonly token: string
  /** The fetch implementation (injectable for keyless replay tests). */
  readonly fetch: typeof globalThis.fetch
}

/** Options of one JSON request. `PATCH`/`PUT` carry the update and label writes (M10). */
export interface RestRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT'
  /** Query parameters; `undefined` values are omitted. */
  readonly query?: Readonly<Record<string, string | number | undefined>>
  /** JSON request body (POST). */
  readonly body?: unknown
  readonly signal?: AbortSignal | undefined
}

/** One JSON response plus the absolute `rel="next"` URL when the reply is paginated. */
export interface RestResponse {
  readonly json: unknown
  readonly next: string | undefined
}

/** Outcome of a paginated read: aggregated items, and whether pagination ran to the end. */
export interface RestPageResult<T> {
  readonly items: T[]
  /** False when a `rel="next"` page was left unfetched (page cap or early stop). */
  readonly exhausted: boolean
}

/** Hard cap on followed pages so a runaway listing cannot spin the provider (execution plan M2). */
export const MAX_PAGES = 10

/** Client identity sent on every request, including unauthenticated redirect follows. */
const USER_AGENT = 'dsh-github-rest'

/**
 * Compose an absolute endpoint URL from the configured base, a `/`-prefixed
 * path, and query parameters. Trailing slashes on the base are tolerated so a
 * GHES base configured as `https://ghe.example.com/api/v3/` joins cleanly.
 * @param baseURL - the API root, with or without trailing slashes.
 * @param path - the endpoint path, starting with `/`.
 * @param query - query parameters; `undefined` values are omitted.
 * @returns the absolute URL.
 */
export function buildUrl(baseURL: string, path: string, query?: RestRequestOptions['query']): string {
  const url = new URL(baseURL.replace(/\/+$/, '') + path)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Extract the absolute `rel="next"` target of an RFC 8288 `Link` header.
 * @param header - the raw header value, or null when absent.
 * @returns the next-page URL, or undefined on the last page.
 */
export function parseLinkNext(header: string | null): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Run one authenticated JSON request against an absolute URL and either return
 * the parsed body or throw the mapped {@link GitHubError}. `next` carries the
 * follow-up URL of a paginated reply.
 * @param transport - base, token, and fetch implementation for this operation.
 * @param url - the absolute request URL (from {@link buildUrl} or a `Link` header).
 * @param options - method, body, and cancellation.
 * @returns the parsed JSON body and the optional next-page URL.
 */
export async function restRequest(transport: RestTransport, url: string, options: RestRequestOptions = {}): Promise<RestResponse> {
  const method = options.method ?? 'GET'
  const response = await sendRequest(transport, url, method, {
    method,
    headers: {
      'accept': 'application/vnd.github+json',
      'authorization': `Bearer ${transport.token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...options.body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }, options.signal)
  if (!response.ok) throw await errorFromResponse(method, url, response)
  return { json: await response.json(), next: parseLinkNext(response.headers.get('link')) }
}

/**
 * Fetch a PLAIN-TEXT endpoint (Actions job logs), following the API's redirect
 * to object storage by hand.
 *
 * The redirect is followed manually and WITHOUT the `Authorization` header
 * (ADR-0015): the target is a different host, and the signed, short-lived URL
 * the API hands back already carries its own grant — forwarding our token there
 * would leak the user's credential to storage infrastructure.
 * @param transport - base, token, and fetch implementation for this operation.
 * @param url - the absolute endpoint URL.
 * @param options - cancellation only; this path is always an unbodied GET.
 * @returns the response body as text.
 */
export async function restTextRequest(
  transport: RestTransport,
  url: string,
  options: Pick<RestRequestOptions, 'signal'> = {},
): Promise<string> {
  const response = await sendRequest(transport, url, 'GET', {
    method: 'GET',
    headers: {
      'authorization': `Bearer ${transport.token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'manual',
    ...options.signal === undefined ? {} : { signal: options.signal },
  }, options.signal)
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location === null) {
      throw new GitHubError(`GitHub redirected GET ${url} without a location header`, 'GITHUB_PROVIDER_HTTP')
    }
    const followed = await sendRequest(transport, location, 'GET', {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      ...options.signal === undefined ? {} : { signal: options.signal },
    }, options.signal)
    if (!followed.ok) throw await errorFromResponse('GET', location, followed)
    return followed.text()
  }
  if (!response.ok) throw await errorFromResponse('GET', url, response)
  return response.text()
}

/** One fetch with transport-level failures mapped to the seam vocabulary. */
async function sendRequest(
  transport: RestTransport,
  url: string,
  method: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await transport.fetch(url, init)
  } catch (cause) {
    if (signal?.aborted) {
      throw new GitHubError(`GitHub request ${method} ${url} was aborted`, 'GITHUB_ABORTED', { cause })
    }
    throw new GitHubError(`GitHub request ${method} ${url} failed before a response arrived`, 'GITHUB_PROVIDER_NETWORK', { cause })
  }
}

/**
 * Follow a paginated listing from its first page, aggregating extracted items,
 * bounded by {@link MAX_PAGES} and an optional early-stop predicate (used by
 * diff reads to stop once a `maxFiles` budget is satisfiable). `exhausted`
 * reports honestly whether a next page was left behind, so callers can set
 * `truncated` without guessing.
 * @param transport - base, token, and fetch implementation for this operation.
 * @param firstUrl - the absolute URL of page one.
 * @param extract - pull the item array out of one page's JSON body.
 * @param options - request options applied to every page.
 * @param enough - optional predicate; once true after a page, later pages stay unfetched.
 * @returns aggregated items and the exhaustion flag.
 */
export async function restPaginate<T>(
  transport: RestTransport,
  firstUrl: string,
  extract: (json: unknown) => readonly T[],
  options: RestRequestOptions = {},
  enough?: (items: readonly T[]) => boolean,
): Promise<RestPageResult<T>> {
  const items: T[] = []
  let url: string | undefined = firstUrl
  for (let page = 0; page < MAX_PAGES && url !== undefined; page += 1) {
    const { json, next }: RestResponse = await restRequest(transport, url, options)
    items.push(...extract(json))
    url = next
    if (enough?.(items)) break
  }
  return { items, exhausted: url === undefined }
}

/** Read the API's own diagnostic out of an error body, tolerating non-JSON replies. */
async function apiMessage(response: Response): Promise<string | undefined> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string') {
      return parsed.message
    }
  } catch {
    // Non-JSON error body (proxy page, empty reply) — fall through to undefined.
  }
  return undefined
}

/** Rate-limit wait from `retry-after` (seconds), or from an exhausted primary quota's reset epoch. */
function retryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
    return Math.max(0, Number(retryAfter)) * 1000
  }
  const reset = headers.get('x-ratelimit-reset')
  if (headers.get('x-ratelimit-remaining') === '0' && reset !== null && Number.isFinite(Number(reset))) {
    return Math.max(0, Number(reset) * 1000 - Date.now())
  }
  return undefined
}

/**
 * Map one non-2xx response to the seam's error vocabulary (execution plan M2):
 * 401 → `GITHUB_AUTH`; 403/429 carrying rate-limit evidence →
 * `GITHUB_RATE_LIMITED { retryAfterMs }`; 404 → `GITHUB_NOT_FOUND`; 422 →
 * `GITHUB_VALIDATION` (the API message is preserved verbatim so callers can
 * recognize replies such as "A pull request already exists"); everything else
 * → `GITHUB_PROVIDER_HTTP`.
 */
async function errorFromResponse(method: string, url: string, response: Response): Promise<GitHubError> {
  const status = response.status
  const detail = await apiMessage(response)
  const suffix = detail === undefined ? '' : `: ${detail}`
  if (status === 401) {
    return new GitHubError(`GitHub rejected the credential (HTTP 401)${suffix}`, 'GITHUB_AUTH')
  }
  if (status === 403 || status === 429) {
    const wait = retryAfterMs(response.headers)
    if (wait !== undefined) {
      return new GitHubError(`GitHub rate limit hit (HTTP ${status})${suffix}`, 'GITHUB_RATE_LIMITED', { retryAfterMs: wait })
    }
  }
  if (status === 404) {
    return new GitHubError(`GitHub resource not found: ${method} ${url}${suffix}`, 'GITHUB_NOT_FOUND')
  }
  // 410 Gone is what expired Actions logs return once past their retention
  // window (ADR-0015). It is an absence, not a transport failure, so it joins
  // 404 rather than the generic HTTP bucket.
  if (status === 410) {
    return new GitHubError(`GitHub resource is gone (expired or purged): ${method} ${url}${suffix}`, 'GITHUB_NOT_FOUND')
  }
  if (status === 422) {
    return new GitHubError(`GitHub rejected the request (HTTP 422)${suffix}`, 'GITHUB_VALIDATION')
  }
  return new GitHubError(`GitHub request ${method} ${url} failed with HTTP ${status}${suffix}`, 'GITHUB_PROVIDER_HTTP')
}
