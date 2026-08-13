/**
 * Package-owned invariant companion for `dsh-github-connect`.
 * @module dsh-github-connect/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-github-connect'

/** Cordis companion plugin name. */
export const name = 'github-connect-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the service's only durable side effect flows through
 * the credentials seam (whose companion owns that surface); flow-state and
 * device-flow events are derived, best-effort projections of git and OAuth
 * facts re-computed per emission, with no registry of their own to check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
