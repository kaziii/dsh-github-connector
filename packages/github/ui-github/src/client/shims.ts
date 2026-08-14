/**
 * Types-only bridge to the dsh client plane (ADR-0008). The dsh client
 * runtime packages are registry-restricted, so this module declares the
 * minimal service surface the client half consumes — `ctx.slots`,
 * `ctx.sessions`, and `ctx.remote`. DELETE this module when the package
 * migrates into the dsh workspace and import the real service types
 * (`@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-api-remotes`)
 * instead; the shapes below mirror theirs member for member.
 * @module dsh-ui-github/client/shims
 */

import type { ReactNode } from 'react'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

/** The slot options subset this plugin registers with. */
export interface ClientSlotOptions {
  readonly name: string
  readonly id: string
  readonly order: number
}

/** Runtime props a slot component receives (session-scope slots carry the id). */
export interface ClientSlotProps {
  readonly sessionId?: string
}

/** `ctx.slots` — the dsh client slot registry (`SlotRegistry`). */
export interface ClientSlotRegistry {
  /**
   * Contribute one component to a slot.
   * @param options - target slot, list identity, and ordering.
   * @param component - the slot component.
   * @returns the registration's disposer.
   */
  register(options: ClientSlotOptions, component: (props: ClientSlotProps) => ReactNode): () => void
  /**
   * Register once the slot is declared, re-running across re-declarations.
   * @param key - the awaited slot key.
   * @param callback - performs the registration, returning its disposer.
   * @returns the injection's disposer.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** `ctx.sessions.scope(id).conversation` — the send verb the [AI review] button uses. */
export interface ClientConversation {
  /**
   * Send one prompt into the session as the user.
   * @param text - the prompt text.
   */
  send(text: string): Promise<unknown>
}

/** One session-addressed service scope. */
export interface ClientSessionScope {
  readonly conversation: ClientConversation
}

/** `ctx.sessions` — the dsh client session addressing service. */
export interface ClientSessions {
  /**
   * Address one session's scoped services.
   * @param sessionId - the target session.
   * @returns the session's scope.
   */
  scope(sessionId: string): ClientSessionScope
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: ClientSlotRegistry
    sessions: ClientSessions
    remote: TypertClientRemote
  }
}
