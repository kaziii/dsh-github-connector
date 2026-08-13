/**
 * GitHub Device Flow client (ADR-0001): request a user code, then poll the
 * token endpoint at the server-dictated interval, handling
 * `authorization_pending` / `slow_down` (+5s) / `expired_token` /
 * `access_denied`. Pure functions over injected `fetch` and `sleep` so every
 * path is testable with the GitHub endpoints fully mocked (M5 DoD).
 * @module dsh-github-connect/device-flow
 */

import { GitHubError } from 'dsh-github'

/** What the UI shows the user: the code to type and where to type it. */
export interface DeviceFlowPrompt {
  readonly userCode: string
  readonly verificationUri: string
  /** Server-dictated seconds between polls. */
  readonly interval: number
  /** Seconds until the device code expires. */
  readonly expiresIn: number
}

/** One progress update pushed to the frontend over `github/device-flow`. */
export type DeviceFlowUpdate =
  | { phase: 'awaiting-authorization', prompt: DeviceFlowPrompt }
  | { phase: 'slow-down', intervalSeconds: number }
  | { phase: 'authorized' }
  | { phase: 'expired' }
  | { phase: 'denied' }
  | { phase: 'failed', message: string }

/** Everything one Device Flow run needs, injected for keyless tests. */
export interface DeviceFlowDeps {
  readonly fetch: typeof globalThis.fetch
  /** Resolves after `ms`, rejecting (or resolving early is fine) on abort. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** OAuth host, `https://github.com` (NOT the API host). */
  readonly authBaseURL: string
  readonly clientId: string
  /** Requested OAuth scope, e.g. `repo`. */
  readonly scope: string
  readonly signal?: AbortSignal
  readonly onUpdate: (update: DeviceFlowUpdate) => void
}

/** POST one OAuth form endpoint, tolerating the JSON accept header contract. */
async function postOAuth(deps: DeviceFlowDeps, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await deps.fetch(`${deps.authBaseURL.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...deps.signal === undefined ? {} : { signal: deps.signal },
    })
  } catch (cause) {
    if (deps.signal?.aborted) {
      throw new GitHubError('the GitHub device flow was aborted', 'GITHUB_ABORTED', { cause })
    }
    throw new GitHubError(`the GitHub device flow request to ${path} failed before a response arrived`, 'GITHUB_CONNECT_NETWORK', { cause })
  }
  if (!response.ok) {
    throw new GitHubError(`the GitHub device flow request to ${path} failed with HTTP ${response.status}`, 'GITHUB_CONNECT_HTTP')
  }
  return await response.json() as Record<string, unknown>
}

/**
 * Request a device + user code pair (`POST /login/device/code`).
 * @param deps - injected transport and identity.
 * @returns the user-facing prompt and the private device code to poll with.
 */
export async function requestDeviceCode(deps: DeviceFlowDeps): Promise<{ prompt: DeviceFlowPrompt, deviceCode: string }> {
  const json = await postOAuth(deps, '/login/device/code', { client_id: deps.clientId, scope: deps.scope })
  const deviceCode = json.device_code
  const userCode = json.user_code
  const verificationUri = json.verification_uri
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new GitHubError('GitHub returned an unusable device code response', 'GITHUB_CONNECT_HTTP')
  }
  return {
    prompt: {
      userCode,
      verificationUri,
      interval: typeof json.interval === 'number' ? json.interval : 5,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
    },
    deviceCode,
  }
}

/**
 * Poll `POST /login/oauth/access_token` until the user authorizes, following
 * the server's pacing: wait `interval` seconds between polls, add 5 seconds on
 * `slow_down`, and settle terminally on `expired_token` / `access_denied`.
 * @param deps - injected transport and identity.
 * @param deviceCode - the private code from {@link requestDeviceCode}.
 * @param intervalSeconds - the initial poll interval from the prompt.
 * @returns the access token.
 */
export async function pollForToken(deps: DeviceFlowDeps, deviceCode: string, intervalSeconds: number): Promise<string> {
  let interval = intervalSeconds
  for (;;) {
    await deps.sleep(interval * 1000, deps.signal)
    if (deps.signal?.aborted) {
      throw new GitHubError('the GitHub device flow was aborted', 'GITHUB_ABORTED')
    }
    const json = await postOAuth(deps, '/login/oauth/access_token', {
      client_id: deps.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const error = json.error
    if (error === undefined) {
      const token = json.access_token
      if (typeof token !== 'string' || token === '') {
        throw new GitHubError('GitHub returned an unusable access token response', 'GITHUB_CONNECT_HTTP')
      }
      // v1 stores only this string through the credentials seam. When GitHub
      // expiring user tokens (ghu_, 8h) become the default, the refresh_token
      // in this response must be persisted too — the credentials seam holds
      // single strings, so the pair would serialize as JSON here (see the
      // execution-plan risk table; deliberately NOT implemented in v1).
      return token
    }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += 5
      deps.onUpdate({ phase: 'slow-down', intervalSeconds: interval })
      continue
    }
    if (error === 'expired_token') {
      throw new GitHubError('the GitHub device code expired before authorization', 'GITHUB_CONNECT_EXPIRED')
    }
    if (error === 'access_denied') {
      throw new GitHubError('the user denied the GitHub authorization request', 'GITHUB_CONNECT_DENIED')
    }
    throw new GitHubError(`GitHub device flow failed: ${String(error)}`, 'GITHUB_CONNECT_HTTP')
  }
}

/**
 * Run one complete Device Flow: request the code, surface the prompt through
 * `onUpdate`, poll to completion, and surface the terminal phase. The token is
 * RETURNED, never stored here — the caller owns the credentials seam write.
 * @param deps - injected transport and identity.
 * @returns the access token and the prompt it was authorized under.
 */
export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<{ token: string, prompt: DeviceFlowPrompt }> {
  const { prompt, deviceCode } = await requestDeviceCode(deps)
  deps.onUpdate({ phase: 'awaiting-authorization', prompt })
  try {
    const token = await pollForToken(deps, deviceCode, prompt.interval)
    deps.onUpdate({ phase: 'authorized' })
    return { token, prompt }
  } catch (error) {
    deps.onUpdate(terminalUpdate(error))
    throw error
  }
}

/** Map a terminal failure to its frontend phase. */
export function terminalUpdate(error: unknown): DeviceFlowUpdate {
  if (error instanceof GitHubError && error.code === 'GITHUB_CONNECT_EXPIRED') return { phase: 'expired' }
  if (error instanceof GitHubError && error.code === 'GITHUB_CONNECT_DENIED') return { phase: 'denied' }
  return { phase: 'failed', message: error instanceof Error ? error.message : String(error) }
}
