/**
 * The settings page's "Connect GitHub" section (design §1): [Connect GitHub]
 * opens the Device Flow authorization page with the user code auto-copied,
 * progress arrives over the forwarded `github/device-flow` event, and a
 * connected user sees `@login` plus [Disconnect]. Written with
 * `createElement` so the package stays inside the repo's `.ts`-only build.
 * @module dsh-ui-github/settings-section
 */

import { createElement as h, useCallback, useEffect, useState, type ReactElement } from 'react'
import { catalogFor, type UiLocale } from './i18n.ts'
import { connectErrorText, connectViewFromStatus, reduceConnectView, type ConnectView } from './model.ts'
import type { GitHubUiRemote, GitHubUiShell } from './types.ts'

/** Props of {@link ConnectGitHubSection}. */
export interface ConnectSectionProps {
  readonly remote: GitHubUiRemote
  readonly shell: GitHubUiShell
  readonly locale?: UiLocale
}

/**
 * The "Connect GitHub" settings section.
 * @param props - the client remote, the shell port, and an optional locale.
 * @returns the section element.
 */
export function ConnectGitHubSection(props: ConnectSectionProps): ReactElement {
  const { remote, shell } = props
  const catalog = catalogFor(props.locale ?? 'en')
  const [view, setView] = useState<ConnectView>({ kind: 'loading' })

  const refresh = useCallback(async (): Promise<void> => {
    setView(connectViewFromStatus(await remote.githubConnect.connectStatus()))
  }, [remote])

  useEffect(() => {
    void refresh()
    const offUpdates = remote.$on('github/device-flow', update => {
      setView(current => reduceConnectView(current, update))
      // 'authorized' only says the token landed; the login comes from a fresh
      // status query (the token itself never transits the frontend).
      if (update.phase === 'authorized') void refresh()
    })
    const offCredentials = remote.$on('credentials/updated', () => void refresh())
    return () => {
      offUpdates()
      offCredentials()
    }
  }, [remote, refresh])

  const connect = useCallback(async (): Promise<void> => {
    setView({ kind: 'loading' })
    const result = await remote.githubConnect.startDeviceFlow()
    if (!result.ok) {
      setView({ kind: 'error', reason: 'failed', message: result.error.message })
      return
    }
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
