/**
 * Package-owned invariant companion for `dsh-ui-github`.
 * @module dsh-ui-github/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-ui-github'

/** Cordis companion plugin name. */
export const name = 'ui-github-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package renders client state derived entirely
 * from `dsh-github-connect`'s Remote results and forwarded events — every
 * durable side effect (credentials, PR creation, merge) already sits behind
 * that host service and its companions; the UI holds no registry of its own.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
