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

/** A text prompt part — all this plugin ever sends. */
export interface ClientPromptTextPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * The outward session face slice this plugin drives (`ISession`): the
 * [AI review] and [Create PR] buttons' prompt verb.
 */
export interface ClientSessionFace {
  /**
   * Send a prompt into the session.
   * @param content - the prompt parts.
   * @param mode - `queue` appends a turn; `steer` interrupts the running one.
   */
  prompt(content: readonly ClientPromptTextPart[], mode: 'queue' | 'steer'): Promise<unknown>
}

/**
 * `ctx.sessions` — the dsh client session addressing service (`ISessions`
 * slice). Both verbs live on this already-injected service; the scoped
 * context stays an opaque handle — property-accessing services on it would
 * re-enter the inject check this plugin cannot satisfy (same rule as
 * ADR-0008's remote namespace).
 */
export interface ClientSessions {
  /**
   * Resolve one session's Agent-scoped context.
   * @param sessionId - the target session.
   * @returns the scoped context, or undefined for an unknown session.
   */
  scope(sessionId: string): object | undefined
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - a context returned by {@link scope}.
   * @returns the face, or undefined when the scope was pruned.
   */
  sessionOf(ctx: object): ClientSessionFace | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: ClientSlotRegistry
    sessions: ClientSessions
    remote: TypertClientRemote
  }
}
