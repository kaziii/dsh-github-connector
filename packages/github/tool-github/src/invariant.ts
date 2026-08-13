/**
 * Package-owned invariant companion for `dsh-tool-github`.
 * @module dsh-tool-github/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-tool-github'

/** Cordis companion plugin name. */
export const name = 'tool-github-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: tool registrations are plain effects observed through
 * `ctx.tools`' own contract (whose companion owns that surface), presenters
 * are pure, and this preset holds no state of its own between calls.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
