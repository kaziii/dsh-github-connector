/**
 * The UI port shape, as wiring: the members `dsh-ui-github`'s shipped client
 * half binds to the dsh web client (ADR-0007 / ADR-0008). Since dsh 0.2.x the
 * package ships that client half itself (`dsh.client` + `lib/client.js`, with
 * UI code kept out of the node entry), so this module is a reference for the
 * port contract, not an adapter to copy into dsh. This module typechecks
 * against the real contracts but is not executed here — the slot registry,
 * Typert Client Remote, and approval surface exist only inside the dsh web
 * client.
 * @module github-quickstart/ui-wiring
 */

import {
  type GitHubUiRemote,
  type GitHubUiShell,
  type GitHubUiSlotId,
} from 'dsh-ui-github'
// The installer lives in the browser half (react is client-only in dsh 0.2.x);
// the node entry intentionally exports no runtime UI values.
import { installGitHubUi } from 'dsh-ui-github/src/install.ts'
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
