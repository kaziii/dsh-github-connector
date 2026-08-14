/**
 * One-call installation: mount the settings section and the status bar into
 * their client slots (design §3) and hand back a single disposer. The web
 * client calls this with its shell adapter and Typert Client Remote.
 * @module dsh-ui-github/install
 */

import { createElement as h } from 'react'
import type { UiLocale } from './i18n.ts'
import { ConnectGitHubSection } from './settings-section.ts'
import type { GitHubUiRemote, GitHubUiShell } from './types.ts'
import { PrStatusBar, type PollPolicy, type StatusBarTimers } from './status-bar.ts'

/** Installation knobs, all defaulted. */
export interface GitHubUiOptions {
  readonly locale?: UiLocale
  readonly poll?: PollPolicy
  readonly collapseMs?: number
  readonly timers?: StatusBarTimers
}

/**
 * Register both slots.
 * @param shell - the client shell adapter (ADR-0007).
 * @param remote - the Typert Client Remote slice.
 * @param options - optional locale and pacing knobs.
 * @returns a disposer that unregisters both slots.
 */
export function installGitHubUi(shell: GitHubUiShell, remote: GitHubUiRemote, options: GitHubUiOptions = {}): () => void {
  const locale = options.locale === undefined ? {} : { locale: options.locale }
  const offSection = shell.registerSlot('settings.section', () =>
    h(ConnectGitHubSection, { remote, shell, ...locale }))
  const offDock = shell.registerSlot('conversation.input.dock', () =>
    h(PrStatusBar, {
      remote,
      shell,
      ...locale,
      ...options.poll === undefined ? {} : { poll: options.poll },
      ...options.collapseMs === undefined ? {} : { collapseMs: options.collapseMs },
      ...options.timers === undefined ? {} : { timers: options.timers },
    }))
  return () => {
    offSection()
    offDock()
  }
}
