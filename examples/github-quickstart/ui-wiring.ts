/**
 * The full UI path, as wiring: what the dsh web client's one-file adapter
 * looks like when it mounts `dsh-ui-github` (ADR-0007). This module
 * typechecks against the real contracts but is not executed here — the slot
 * registry, Typert Client Remote, and approval surface exist only inside the
 * dsh web client. Copy `wireGitHubUi` into that adapter and replace each
 * `shell` member with the client's real facility.
 * @module github-quickstart/ui-wiring
 */

import {
  installGitHubUi,
  type GitHubUiRemote,
  type GitHubUiShell,
  type GitHubUiSlotId,
} from 'dsh-ui-github'
import type { ReactNode } from 'react'

/** The client facilities the adapter bridges (design §7 names in comments). */
export interface WebClientFacilities {
  /** The client slot registry (`settings.section` / `conversation.input.dock`). */
  registerSlot(slot: GitHubUiSlotId, render: () => ReactNode): () => void
  /** The session the conversation dock renders for (ADR-0010). */
  currentSessionId(): string | undefined
  /** `sessions.prompt` — the [AI review] button's model turn. */
  sendPrompt(text: string): void
  /** The host approval surface reused for the irreversible Merge confirmation. */
  confirm(question: string): Promise<boolean>
}

/**
 * Mount the GitHub UI into the web client.
 * @param remote - the Typert Client Remote (any `TypertClientRemote` satisfies
 *   the `GitHubUiRemote` slice structurally).
 * @param facilities - the client's real slot/prompt/approval surfaces.
 * @returns the disposer that unregisters both slots.
 */
export function wireGitHubUi(remote: GitHubUiRemote, facilities: WebClientFacilities): () => void {
  const shell: GitHubUiShell = {
    registerSlot: (slot, render) => facilities.registerSlot(slot, render),
    sessionId: () => facilities.currentSessionId(),
    prompt: text => facilities.sendPrompt(text),
    openExternal: url => void window.open(url, '_blank', 'noopener'),
    copyText: text => navigator.clipboard.writeText(text),
    confirmIrreversible: question => facilities.confirm(question),
    visibility: {
      visible: () => document.visibilityState === 'visible',
      onChange: listener => {
        const handler = (): void => listener(document.visibilityState === 'visible')
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
      },
    },
  }
  return installGitHubUi(shell, remote, { locale: 'zh-CN' })
}
