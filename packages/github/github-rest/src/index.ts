/**
 * Function plugin wiring the {@link RestGitHubProvider} into `ctx.github`.
 * The token resolves per operation through the optional credentials seam with
 * a process-environment fallback (the CLI path: exporting `GITHUB_TOKEN` just
 * works), and `installSettingsSection` attaches the config to the optional
 * user-settings seam so credential-ref and base-URL changes apply live. The
 * settings section stores the credential REFERENCE, never a token value.
 *
 * NO default export — the dsh Loader drops `inject` from default-exported
 * function plugins (engineering gate §8).
 * @module dsh-github-rest
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { GitHubError } from 'dsh-github'
import { RestGitHubProvider, type ResolvedRestConfig } from './provider.ts'

export { PROVIDER_ID, RestGitHubProvider } from './provider.ts'
export type { ResolvedRestConfig, RestGitHubProviderOptions } from './provider.ts'
export { buildUrl, MAX_PAGES, parseLinkNext, restPaginate, restRequest, restTextRequest } from './http.ts'
export type { RestPageResult, RestRequestOptions, RestResponse, RestTransport } from './http.ts'

/** Plugin config; doubles as the `github-rest` settings-section schema. */
export type GitHubRestConfig = ResolvedRestConfig

/** Cordis plugin name. */
export const name = 'github-rest'
/** The seam this provider registers into. Optional seams (credentials, settings) are read via `ctx.get`. */
export const inject = ['github']

/**
 * Config schema. `credentialRef` names an environment variable — a reference,
 * resolved through the credentials seam or the process environment, never a
 * secret itself — so the settings document stays free of token values.
 */
export const Config: z<GitHubRestConfig> = z.object({
  credentialRef: z.string().default('GITHUB_TOKEN'),
  baseURL: z.string().default('https://api.github.com'),
})

/**
 * Mount the REST provider: wire live config sourcing, per-operation credential
 * resolution, and registry membership (an effect riding this plugin's fiber).
 * @param ctx - plugin context carrying `ctx.github`.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: GitHubRestConfig): void {
  let source: () => GitHubRestConfig = () => config
  const provider = new RestGitHubProvider({
    config: () => source(),
    resolveToken: ref => resolveToken(ctx, ref),
    tokenConfigured: ref => ctx.get('credentials') !== undefined || envToken(ref) !== undefined,
  })
  installSettingsSection(ctx, settingsNamespace('github-rest'), Config, config, {
    setSource: current => { source = current },
    // Nothing is memoized between operations — each one re-reads `source()` —
    // so a committed settings change needs no re-judgement here.
    onChange: () => {},
  })
  ctx.github.registerProvider(provider)
}

/**
 * Resolve the credential reference for ONE operation: the credentials seam
 * wins when it is mounted and configured; the process environment is the
 * fallback either way, keeping the tokenless-CLI path alive.
 * @param ctx - context possibly carrying the optional credentials seam.
 * @param ref - environment-variable name to resolve.
 * @returns the token, or undefined while unconfigured anywhere.
 */
async function resolveToken(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(brandRef(ref))
    if (resolved !== undefined) return resolved.value
  }
  return envToken(ref)
}

/** Brand a configured ref, mapping an unusable name to the seam's validation error. */
function brandRef(ref: string): ReturnType<typeof credentialRef> {
  try {
    return credentialRef(ref)
  } catch (cause) {
    throw new GitHubError(`credential ref "${ref}" is not a usable environment-variable name`, 'GITHUB_VALIDATION', { cause })
  }
}

/** Read a non-blank token from the process environment, or undefined. */
function envToken(ref: string): string | undefined {
  const value = process.env[ref]
  const trimmed = value === undefined ? '' : value.trim()
  return trimmed === '' ? undefined : trimmed
}
