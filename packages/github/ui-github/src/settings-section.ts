/**
 * The settings page's "Connect GitHub" section (design §1, mounted as the
 * plugin-config card per ADR-0008): [Connect GitHub] opens the Device Flow
 * authorization page with the user code auto-copied, progress arrives by
 * polling `deviceFlowStatus` at the server-dictated interval (ADR-0009: dsh
 * never forwards `github/device-flow` to the browser), and a connected user
 * sees `@login` plus [Disconnect]. Written with `createElement` so the
 * package stays inside the repo's `.ts`-only build.
 * @module dsh-ui-github/settings-section
 */

import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { catalogFor, type UiLocale } from './i18n.ts'
import { connectErrorText, connectViewFromStatus, reduceConnectView, type ConnectView } from './model.ts'
import { defaultTimers, type StatusBarTimers } from './status-bar.ts'
import type { GitHubUiRemote, GitHubUiShell } from './types.ts'

/** Props of {@link ConnectGitHubSection}. */
export interface ConnectSectionProps {
  readonly remote: GitHubUiRemote
  readonly shell: GitHubUiShell
  readonly locale?: UiLocale
  /** Injectable timers (tests drive the status poll deterministically). */
  readonly timers?: StatusBarTimers
}

/**
 * The "Connect GitHub" settings section.
 * @param props - the client remote, the shell port, and an optional locale.
 * @returns the section element.
 */
export function ConnectGitHubSection(props: ConnectSectionProps): ReactElement {
  const { remote, shell } = props
  const catalog = catalogFor(props.locale ?? 'en')
  const timers = props.timers ?? defaultTimers
  const [view, setView] = useState<ConnectView>({ kind: 'loading' })
  // Server-dictated pacing: seeded by the prompt's interval, stretched by
  // slow-down updates (the reducer treats those as view no-ops).
  const pollMsRef = useRef(5_000)

  const refresh = useCallback(async (): Promise<void> => {
    setView(connectViewFromStatus(await remote.githubConnect.connectStatus()))
  }, [remote])

  useEffect(() => {
    void refresh()
    const offCredentials = remote.$on('credentials/updated', () => void refresh())
    return offCredentials
  }, [remote, refresh])

  const waiting = view.kind === 'waiting'
  useEffect(() => {
    if (!waiting) return
    let disposed = false
    let handle: unknown
    const schedule = (): void => {
      handle = timers.setTimeout(() => void tick(), pollMsRef.current)
    }
    const tick = async (): Promise<void> => {
      const result = await remote.githubConnect.deviceFlowStatus()
      if (disposed) return
      // A transient poll failure (or a not-yet-started flow) keeps waiting.
      if (!result.ok || result.value === undefined) {
        schedule()
        return
      }
      const update = result.value
      switch (update.phase) {
        case 'slow-down':
          pollMsRef.current = update.intervalSeconds * 1000
          schedule()
          return
        case 'awaiting-authorization':
          schedule()
          return
        case 'authorized':
          setView(current => reduceConnectView(current, update))
          // 'authorized' only says the token landed; the login comes from a
          // fresh status query (the token itself never transits the frontend).
          void refresh()
          return
        default:
          setView(current => reduceConnectView(current, update))
      }
    }
    schedule()
    return () => {
      disposed = true
      timers.clearTimeout(handle)
    }
  }, [waiting, remote, timers, refresh])

  const connect = useCallback(async (): Promise<void> => {
    setView({ kind: 'loading' })
    const result = await remote.githubConnect.startDeviceFlow()
    if (!result.ok) {
      setView({ kind: 'error', reason: 'failed', message: result.error.message })
      return
    }
    pollMsRef.current = result.value.interval * 1000
    await shell.copyText(result.value.userCode)
    shell.openExternal(result.value.verificationUri)
    setView({ kind: 'waiting', userCode: result.value.userCode, verificationUri: result.value.verificationUri })
  }, [remote, shell])

  const disconnect = useCallback(async (): Promise<void> => {
    await remote.githubConnect.disconnect()
    setView({ kind: 'disconnected' })
  }, [remote])

  switch (view.kind) {
    case 'loading':
      return h('div', { className: 'gh-connect' }, catalog.connectLoading)
    case 'disconnected':
      return h('div', { className: 'gh-connect' },
        h('button', { onClick: () => void connect() }, catalog.connectButton))
    case 'waiting':
      return h('div', { className: 'gh-connect' }, catalog.waitingForAuthorization(view.userCode))
    case 'connected':
      return h('div', { className: 'gh-connect' },
        h('span', null, view.login === undefined ? catalog.connectedAnonymous : catalog.connectedAs(view.login)),
        h('button', { onClick: () => void disconnect() }, catalog.disconnectButton))
    case 'error':
      return h('div', { className: 'gh-connect' },
        h('span', null, connectErrorText(view, catalog)),
        h('button', { onClick: () => void connect() }, catalog.retryButton))
  }
}
