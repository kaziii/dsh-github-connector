/**
 * Pure view models: what each slot shows as a function of Remote results and
 * forwarded events. Keeping the folds here leaves the components as thin
 * render/dispatch shells and lets every branch be pinned by direct unit tests.
 * @module dsh-ui-github/model
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceFlowUpdate, GitHubFlowState } from 'dsh-github-connect'
import type { UiCatalog } from './i18n.ts'
import type { ConnectStatus } from './types.ts'

/** The settings section's five faces. */
export type ConnectView =
  | { kind: 'loading' }
  | { kind: 'disconnected' }
  | { kind: 'waiting', userCode: string, verificationUri: string }
  | { kind: 'connected', login?: string }
  | { kind: 'error', reason: 'expired' | 'denied' | 'failed', message?: string }

/**
 * Fold one `connectStatus()` result into the section view.
 * @param result - the Remote call's result.
 * @returns the view the result proves.
 */
export function connectViewFromStatus(result: RemoteResult<ConnectStatus>): ConnectView {
  if (!result.ok) return { kind: 'error', reason: 'failed', message: result.error.message }
  if (!result.value.connected) return { kind: 'disconnected' }
  return {
    kind: 'connected',
    ...result.value.login === undefined ? {} : { login: result.value.login },
  }
}

/**
 * Advance the section view on one forwarded Device Flow update.
 * @param view - the current view.
 * @param update - the forwarded `github/device-flow` update.
 * @returns the next view; `slow-down` is pacing-only and changes nothing.
 */
export function reduceConnectView(view: ConnectView, update: DeviceFlowUpdate): ConnectView {
  switch (update.phase) {
    case 'awaiting-authorization':
      return { kind: 'waiting', userCode: update.prompt.userCode, verificationUri: update.prompt.verificationUri }
    case 'slow-down':
      return view
    case 'authorized':
      return { kind: 'loading' }
    case 'expired':
      return { kind: 'error', reason: 'expired' }
    case 'denied':
      return { kind: 'error', reason: 'denied' }
    case 'failed':
      return { kind: 'error', reason: 'failed', message: update.message }
  }
}

/**
 * Localize one error view.
 * @param view - the error view.
 * @param catalog - the active catalog.
 * @returns the message to show next to [Retry].
 */
export function connectErrorText(view: Extract<ConnectView, { kind: 'error' }>, catalog: UiCatalog): string {
  switch (view.reason) {
    case 'expired':
      return catalog.deviceExpired
    case 'denied':
      return catalog.deviceDenied
    case 'failed':
      return catalog.deviceFailed(view.message ?? '')
  }
}

/** The [Merge ▾] dropdown's strategy order (design §1). */
export const MERGE_METHODS = Object.freeze(['squash', 'merge', 'rebase'] as const)

/**
 * Whether two flow states show the same bar (ADR-0009: the poller applies a
 * refreshed state only on a real transition, so an unchanged poll never
 * closes an open dropdown or discards a draft title). The CI rollup of
 * `pr-open` is deliberately ignored — it updates in place through the badge,
 * not by re-adopting the state.
 * @param a - the currently shown state.
 * @param b - the freshly polled state.
 * @returns whether the bar should keep its current state object.
 */
export function sameFlowState(a: GitHubFlowState, b: GitHubFlowState): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'hidden':
      return true
    case 'pr-ready':
      return b.kind === 'pr-ready' && a.branch === b.branch && a.base === b.base && a.aheadCount === b.aheadCount
        && a.additions === b.additions && a.deletions === b.deletions
    case 'pr-open':
      return b.kind === 'pr-open' && a.branch === b.branch && a.number === b.number && a.url === b.url
    case 'pr-merged':
      return b.kind === 'pr-merged' && a.branch === b.branch && a.number === b.number
  }
}
