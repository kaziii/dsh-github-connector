/**
 * Shared vocabulary of the `github_*` tool suite: the `owner/repo` argument
 * convention, model-friendly error translation, and small pure formatting
 * helpers. Everything here is deliberately presentation-safe (total, throw-free
 * unless documented) because presenters replay logged sessions.
 * @module dsh-tool-github/shared
 */

import { GitHubError, type GitHubRepoRef } from 'dsh-github'

/** Resolved plugin config: every field present (schema defaults applied). */
export interface ResolvedToolGitHubConfig {
  readonly write: boolean
  readonly searchMaxResults: number
  readonly maxComments: number
  readonly diffMaxFiles: number
  readonly diffMaxPatchChars: number
  readonly logMaxLines: number
  readonly logMaxChars: number
  readonly timeoutMs: number
}

/**
 * Parse the model-facing `owner/repo` argument. Throws a plain `Error` (a
 * model-visible argument problem, not a provider failure) on any other shape.
 * @param repo - the raw argument.
 * @returns the seam's repo ref.
 */
export function parseRepoInput(repo: string): GitHubRepoRef {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo.trim())
  if (match === null) throw new Error(`repo must be "owner/repo", got "${repo}"`)
  return { owner: match[1]!, repo: match[2]! }
}

/** The `owner/repo` display label of a repo ref. */
export function repoLabel(repo: GitHubRepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

/**
 * Validate a positive-integer tool argument the schema DSL cannot bound.
 * @param name - argument name for the diagnostic.
 * @param value - the schema-validated numeric argument.
 */
export function assertPositiveArg(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`)
}

/**
 * Translate a seam failure into the message a model can act on. Rate limits
 * become a wait-and-retry hint carrying the seam's `retryAfterMs`; auth and
 * not-found name the fix. Anything else passes through unchanged.
 * @param error - whatever the operation threw.
 * @returns the value to rethrow.
 */
export function toModelError(error: unknown): unknown {
  if (!(error instanceof GitHubError)) return error
  switch (error.code) {
    case 'GITHUB_RATE_LIMITED': {
      const wait = error.retryAfterMs === undefined ? 'a moment' : `~${Math.max(1, Math.ceil(error.retryAfterMs / 1000))}s`
      return new Error(`GitHub rate limit hit. Wait ${wait} and retry; prefer direct issue/PR reads over search meanwhile.`)
    }
    case 'GITHUB_AUTH':
      return new Error('GitHub credential is missing or was rejected. Ask the user to connect GitHub (or set GITHUB_TOKEN), then retry.')
    case 'GITHUB_NOT_FOUND':
      return new Error('GitHub resource not found: check the owner/repo and number, or the token may lack access.')
    default:
      return error
  }
}

/**
 * Run one seam operation with model-friendly failure translation.
 * @param op - the operation.
 * @returns the operation's result.
 */
export async function runGitHub<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (error) {
    throw toModelError(error)
  }
}

/** First line of a body, hard-capped for approval prompts and titles. */
export function preview(text: string | undefined, max = 120): string {
  if (text === undefined || text.trim() === '') return ''
  const line = text.trim().split('\n', 1)[0]!
  return line.length > max ? `${line.slice(0, max)}…` : line
}
