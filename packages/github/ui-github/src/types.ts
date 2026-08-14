/**
 * Types-only module (dsh convention): the two contracts this UI stands on.
 *
 * 1. The hand-authored Typert Remote client face for the `githubConnect`
 *    namespace, mirroring the generated `typert.remote-client` artifact of the
 *    dsh full-stack template (`@deepseek-ai/dsh-message-feedback/remote`):
 *    endpoint signatures in `TypertRemoteMap`, the namespace in
 *    `TypertRemoteNamespaceMap`, and the forwarded-event selection this UI
 *    subscribes to. Once the dsh Typert generator runs over
 *    `dsh-github-connect`'s FaceModel, its artifact replaces the augmentation
 *    byte-for-type (ADR-0007).
 * 2. The client-shell port (ADR-0007): the narrow surface this package needs
 *    from the dsh web client — slot registration, `sessions.prompt`, window
 *    and clipboard access, the irreversible-action confirmation, and page
 *    visibility. The dsh client plane is registry-restricted, so the web
 *    client supplies a one-file adapter over its real slot registry at
 *    composition time; this package never imports it.
 *
 * @module dsh-ui-github/types
 */

import type { ReactNode } from 'react'
import type { Events } from '@deepseek-ai/cordis'
import type {
  RemoteResult,
  TypertRemoteEvent,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  ChecksSummary,
  CreatePrResult,
  DeviceFlowPrompt,
  DeviceFlowUpdate,
  GitHubFlowState,
  MergeMethod,
  PrDraft,
} from 'dsh-github-connect'
import type {} from '@deepseek-ai/dsh-credentials'

// —— Typert Remote client face ————————————————————————————————————————————————

/** `connectStatus()`'s business result (the settings section's state source). */
export interface ConnectStatus {
  readonly connected: boolean
  readonly login?: string
}

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface TypertRemoteMap {
    'githubConnect/connectStatus': () => Promise<RemoteResult<ConnectStatus>>
    'githubConnect/startDeviceFlow': () => Promise<RemoteResult<DeviceFlowPrompt>>
    'githubConnect/deviceFlowStatus': () => Promise<RemoteResult<DeviceFlowUpdate | undefined>>
    'githubConnect/disconnect': () => Promise<RemoteResult<void>>
    // ADR-0010: the git-touching methods carry the calling session so the host
    // resolves that session's workspace directory. The parameter is declared
    // non-optional (the client call layer demands an exact argument count);
    // pass `undefined` fields freely — they never reach the wire.
    'githubConnect/prDraft': (request: { sessionId?: string | undefined }) => Promise<RemoteResult<PrDraft>>
    'githubConnect/createPr': (request: { title: string, body?: string, base?: string, sessionId?: string | undefined }) => Promise<RemoteResult<CreatePrResult>>
    'githubConnect/mergePr': (request: { number: number, method: MergeMethod, sessionId?: string | undefined }) => Promise<RemoteResult<{ merged: boolean, sha?: string }>>
    'githubConnect/prChecks': (number: number, sessionId: string | undefined) => Promise<RemoteResult<ChecksSummary | undefined>>
    'githubConnect/refreshFlowState': (request: { sessionId?: string | undefined }) => Promise<RemoteResult<GitHubFlowState>>
  }
  interface TypertRemoteNamespaceMap {
    githubConnect: TypertRemoteNamespace<'githubConnect'>
  }
  // ADR-0009: dsh forwards only a fixed host event set to the browser, and
  // custom events like github/flow-state are NOT in it — a wider selection
  // here would type-check and then never fire. Everything beyond credential
  // changes arrives by frontend-paced polling instead.
  interface TypertRemoteEventSelection {
    'credentials/updated': true
  }
}

/**
 * The slice of the Typert Client Remote this UI consumes: the `githubConnect`
 * namespace plus event subscription. Any `TypertClientRemote` satisfies it
 * structurally; tests satisfy it with a scripted fake.
 */
export interface GitHubUiRemote {
  readonly githubConnect: TypertRemoteNamespace<'githubConnect'>
  /**
   * Subscribe to one forwarded Host event.
   * @param event - forwarded event name.
   * @param listener - receives the Host's argument list.
   * @returns the subscription's disposer.
   */
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
}

// —— client-shell port ————————————————————————————————————————————————————————

/** The two client slots this package fills (design §3). */
export type GitHubUiSlotId = 'settings.section' | 'conversation.input.dock'

/** Page-visibility source for the CI badge poller (pause while hidden). */
export interface GitHubUiVisibility {
  /** @returns whether the page is currently visible. */
  visible(): boolean
  /**
   * Watch visibility transitions.
   * @param listener - receives the new visibility.
   * @returns the subscription's disposer.
   */
  onChange(listener: (visible: boolean) => void): () => void
}

/** What the dsh web client adapts for this UI. */
export interface GitHubUiShell {
  /**
   * Mount one render function into a client slot.
   * @param slot - the slot id.
   * @param render - produces the slot's React content on each slot render.
   * @returns the registration's disposer.
   */
  registerSlot(slot: GitHubUiSlotId, render: () => ReactNode): () => void
  /**
   * The session the dock currently renders for (ADR-0010): its id rides every
   * git-touching Remote call so the host detects in that session's workspace.
   * @returns the session id, or undefined before the first dock render.
   */
  sessionId(): string | undefined
  /**
   * Send one prompt into the active session — the [AI review] button's path,
   * the only button that spends a model turn (design §6).
   * @param text - the prompt text.
   */
  prompt(text: string): void
  /**
   * Open one external URL (the authorization page, a PR page).
   * @param url - the absolute URL.
   */
  openExternal(url: string): void
  /**
   * Copy text to the clipboard (the Device Flow user code auto-copy).
   * @param text - the text to copy.
   */
  copyText(text: string): Promise<void>
  /**
   * Confirm one irreversible action through the host's approval surface —
   * the [Merge] path (design §6).
   * @param question - the localized question to show.
   * @returns whether the user confirmed.
   */
  confirmIrreversible(question: string): Promise<boolean>
  /** Page-visibility source consumed by the CI badge poller. */
  readonly visibility: GitHubUiVisibility
}
