/**
 * The browser-side {@link GitHubUiShell} adapter (ADR-0008): binds the port's
 * members to the dsh client services and plain browser facilities.
 *
 * - `registerSlot('settings.section')` narrows to a `settings.plugin.item`
 *   card (the "插件 → 插件配置" page); the dock keeps its slot name.
 * - `prompt` sends into the session the dock last rendered for — v1 renders
 *   one active conversation at a time, matching the dsh web layout.
 * - `openExternal` opens http(s) URLs only, mirroring the dsh safe-anchor
 *   convention; anything else is silently refused.
 * @module dsh-ui-github/client/shell
 */

import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { GitHubUiShell, GitHubUiSlotId } from '../types.ts'
import type { ClientSlotProps } from './shims.ts'

/** Where each port slot id lands in the dsh slot registry (ADR-0008). */
const SLOT_TARGETS: Record<GitHubUiSlotId, string> = {
  'settings.section': 'settings.plugin.item',
  'conversation.input.dock': 'conversation.input.dock',
}

/** List-slot ordering after the built-in dsh cards and docks. */
const SLOT_ORDER = 30

/**
 * Build the shell over the client context.
 * @param ctx - the client plugin's context (slots + sessions services).
 * @returns the port implementation `installGitHubUi` mounts through.
 */
export function createBrowserShell(ctx: Context): GitHubUiShell {
  let currentSession: string | undefined
  return {
    registerSlot: (slot, render) => {
      const target = SLOT_TARGETS[slot]
      const component = (props: ClientSlotProps): ReactNode => {
        if (props.sessionId !== undefined) currentSession = props.sessionId
        return render()
      }
      return ctx.slots.inject(target, () =>
        ctx.slots.register({ name: target, id: 'github', order: SLOT_ORDER }, component))
    },
    prompt: text => {
      if (currentSession === undefined) return
      void ctx.sessions.scope(currentSession).conversation.send(text)
    },
    openExternal: url => {
      if (!/^https?:\/\//.test(url)) return
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    copyText: async text => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard denial (or a jsdom environment without the API): the
        // user code stays visible in the card, so nothing else can fail.
      }
    },
    confirmIrreversible: question => Promise.resolve(window.confirm(question)),
    visibility: {
      visible: () => !document.hidden,
      onChange: listener => {
        const handler = (): void => listener(!document.hidden)
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
      },
    },
  }
}
