/**
 * The conversation PR status bar (design §1/§2): mounted above the input,
 * driven by frontend-paced `refreshFlowState` polling (ADR-0009: dsh never
 * forwards `github/flow-state` to the browser) plus an immediate re-sync on
 * `credentials/updated`, hidden for unconnected users. [Create PR] and
 * [Merge] go straight to `@Remote` methods (zero model turns); [AI review] is
 * the one button that spends a turn, through `shell.prompt`. Both the
 * flow-state poller and the CI badge poller back off and STOP while the page
 * is hidden.
 * @module dsh-ui-github/status-bar
 */

import { createElement as h, useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import type { ChecksSummary, GitHubFlowState, MergeMethod } from 'dsh-github-connect'
import { catalogFor, type UiLocale } from './i18n.ts'
import { MERGE_METHODS, sameFlowState } from './model.ts'
import type { GitHubUiRemote, GitHubUiShell } from './types.ts'

/** CI badge poll pacing: start at `initialMs`, double to at most `maxMs`. */
export interface PollPolicy {
  readonly initialMs: number
  readonly maxMs: number
}

/** Injectable timer pair (tests drive polls and the collapse deterministically). */
export interface StatusBarTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Real timers, used unless a test injects its own. */
export const defaultTimers: StatusBarTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Default badge pacing (risk table: checks polling must not eat rate limit). */
const DEFAULT_POLL: PollPolicy = { initialMs: 15_000, maxMs: 120_000 }

/**
 * Default flow-state pacing (ADR-0009). Slower than the badge: a state
 * transition needs a whole git/PR round-trip host-side, and the turn-end
 * moments it replaces are minutes apart.
 */
const DEFAULT_FLOW_POLL: PollPolicy = { initialMs: 30_000, maxMs: 300_000 }

/** How long the merged banner stays before the bar collapses (design §1 stage 3). */
const DEFAULT_COLLAPSE_MS = 5_000

/** Props of {@link PrStatusBar}. */
export interface PrStatusBarProps {
  readonly remote: GitHubUiRemote
  readonly shell: GitHubUiShell
  readonly locale?: UiLocale
  readonly poll?: PollPolicy
  /** Flow-state poll pacing (ADR-0009), independent of the CI badge's. */
  readonly flowPoll?: PollPolicy
  readonly collapseMs?: number
  readonly timers?: StatusBarTimers
}

/** Which dropdown is open. */
type OpenMenu = 'none' | 'create' | 'merge'

/**
 * The PR status bar.
 * @param props - the client remote, the shell port, and optional pacing knobs.
 * @returns the bar element, or null while hidden.
 */
export function PrStatusBar(props: PrStatusBarProps): ReactElement | null {
  const { remote, shell } = props
  const catalog = catalogFor(props.locale ?? 'en')
  const poll = props.poll ?? DEFAULT_POLL
  const flowPoll = props.flowPoll ?? DEFAULT_FLOW_POLL
  const collapseMs = props.collapseMs ?? DEFAULT_COLLAPSE_MS
  const timers = props.timers ?? defaultTimers

  const [state, setState] = useState<GitHubFlowState>({ kind: 'hidden' })
  const [ci, setCi] = useState<ChecksSummary | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<OpenMenu>('none')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  // The poller compares against what is currently shown without re-running
  // its effect on every render.
  const stateRef = useRef(state)
  stateRef.current = state
  // The merged banner collapses locally while the host keeps detecting
  // pr-merged until the branch moves on; remembering what collapsed keeps the
  // poller from resurrecting the banner every round (ADR-0009).
  const collapsedRef = useRef<{ branch: string, number: number } | undefined>(undefined)

  /** Adopt one authoritative state: clear per-state leftovers alongside. */
  const apply = useCallback((next: GitHubFlowState): void => {
    setState(next)
    setNotice(undefined)
    setMenu('none')
    setCi(next.kind === 'pr-open' ? next.ci : undefined)
  }, [])

  /**
   * One poll round: adopt a real transition, fold an unchanged `pr-open` into
   * the badge only (an unchanged poll must never close a dropdown or discard
   * a draft), and keep the last known state on failure — the bar never
   * surfaces infrastructure noise (design: unconnected users see nothing).
   */
  const sync = useCallback(async (): Promise<void> => {
    const result = await remote.githubConnect.refreshFlowState()
    if (!result.ok) return
    const next = result.value
    if (next.kind === 'pr-merged'
      && collapsedRef.current !== undefined
      && collapsedRef.current.branch === next.branch
      && collapsedRef.current.number === next.number) return
    collapsedRef.current = undefined
    if (!sameFlowState(stateRef.current, next)) apply(next)
    else if (next.kind === 'pr-open' && next.ci !== undefined) setCi(next.ci)
  }, [remote, apply])

  useEffect(() => {
    let disposed = false
    let delay = flowPoll.initialMs
    let handle: unknown
    const schedule = (): void => {
      // Paused while hidden; the visibility listener below resumes.
      if (!shell.visibility.visible()) return
      handle = timers.setTimeout(() => void tick(), delay)
    }
    const tick = async (): Promise<void> => {
      await sync()
      if (disposed) return
      delay = Math.min(delay * 2, flowPoll.maxMs)
      schedule()
    }
    void sync().then(() => {
      if (!disposed) schedule()
    })
    const offVisibility = shell.visibility.onChange(visible => {
      timers.clearTimeout(handle)
      if (visible) {
        delay = flowPoll.initialMs
        schedule()
      }
    })
    // Disconnect (or any credential change) re-derives the state through the
    // host gate, which reads hidden without a token — the bar disappears
    // immediately (M6 DoD).
    const offCredentials = remote.$on('credentials/updated', () => {
      timers.clearTimeout(handle)
      delay = flowPoll.initialMs
      void tick()
    })
    return () => {
      disposed = true
      timers.clearTimeout(handle)
      offVisibility()
      offCredentials()
    }
  }, [remote, shell, flowPoll, timers, sync])

  useEffect(() => {
    if (state.kind !== 'pr-merged') return
    const merged = { branch: state.branch, number: state.number }
    const handle = timers.setTimeout(() => {
      collapsedRef.current = merged
      setState({ kind: 'hidden' })
    }, collapseMs)
    return () => timers.clearTimeout(handle)
  }, [state, timers, collapseMs])

  useEffect(() => {
    if (state.kind !== 'pr-open') return
    const number = state.number
    let disposed = false
    let delay = poll.initialMs
    let handle: unknown
    const schedule = (): void => {
      // Paused while hidden; the visibility listener below resumes.
      if (!shell.visibility.visible()) return
      handle = timers.setTimeout(() => void tick(), delay)
    }
    const tick = async (): Promise<void> => {
      const result = await remote.githubConnect.prChecks(number)
      if (disposed) return
      if (result.ok) setCi(result.value)
      delay = Math.min(delay * 2, poll.maxMs)
      schedule()
    }
    schedule()
    const offVisibility = shell.visibility.onChange(visible => {
      timers.clearTimeout(handle)
      if (visible) {
        delay = poll.initialMs
        schedule()
      }
    })
    return () => {
      disposed = true
      timers.clearTimeout(handle)
      offVisibility()
    }
  }, [state, remote, shell, poll, timers])

  const createPr = useCallback(async (branch: string): Promise<void> => {
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    const result = await remote.githubConnect.createPr({
      title: trimmedTitle === '' ? branch : trimmedTitle,
      ...trimmedBody === '' ? {} : { body: trimmedBody },
    })
    if (!result.ok) {
      setNotice(result.error.message)
      return
    }
    const refreshed = await remote.githubConnect.refreshFlowState()
    if (refreshed.ok) apply(refreshed.value)
  }, [remote, title, body, apply])

  const merge = useCallback(async (number: number, method: MergeMethod): Promise<void> => {
    setMenu('none')
    const confirmed = await shell.confirmIrreversible(catalog.mergeConfirm(number, catalog.mergeMethodLabel(method)))
    if (!confirmed) return
    const result = await remote.githubConnect.mergePr({ number, method })
    if (!result.ok) {
      setNotice(catalog.mergeFailed(result.error.message))
      return
    }
    const refreshed = await remote.githubConnect.refreshFlowState()
    if (refreshed.ok) apply(refreshed.value)
  }, [remote, shell, catalog, apply])

  if (state.kind === 'hidden') return null

  const parts: ReactNode[] = []
  switch (state.kind) {
    case 'pr-ready': {
      const branch = state.branch
      parts.push(
        h('span', { key: 'ahead' }, catalog.aheadOfBase(state.branch, state.base, state.aheadCount)),
        h('button', { key: 'create', onClick: () => setMenu(menu === 'create' ? 'none' : 'create') }, catalog.createPrButton),
      )
      if (menu === 'create') {
        parts.push(h('div', { key: 'create-menu', className: 'gh-create-menu' },
          h('input', {
            value: title,
            placeholder: catalog.prTitlePlaceholder,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
          }),
          h('textarea', {
            value: body,
            placeholder: catalog.prBodyPlaceholder,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value),
          }),
          h('button', { onClick: () => void createPr(branch) }, catalog.confirmCreateButton),
        ))
      }
      break
    }
    case 'pr-open': {
      const number = state.number
      const url = state.url
      parts.push(
        url === undefined
          ? h('span', { key: 'pr' }, catalog.openPr(number))
          : h('a', { key: 'pr', href: url, target: '_blank', rel: 'noreferrer' }, catalog.openPr(number)),
      )
      if (ci !== undefined) parts.push(h('span', { key: 'ci', className: `gh-ci-${ci}` }, catalog.ciBadge(ci)))
      parts.push(
        h('button', { key: 'review', onClick: () => shell.prompt(catalog.reviewPrompt(number)) }, catalog.reviewButton),
        h('button', { key: 'merge', onClick: () => setMenu(menu === 'merge' ? 'none' : 'merge') }, catalog.mergeButton),
      )
      if (menu === 'merge') {
        const items: ReactNode[] = MERGE_METHODS.map(method =>
          h('button', { key: method, onClick: () => void merge(number, method) }, catalog.mergeMethodLabel(method)))
        if (url !== undefined) {
          items.push(h('button', { key: 'open', onClick: () => shell.openExternal(url) }, catalog.openOnGitHub))
        }
        parts.push(h('div', { key: 'merge-menu', className: 'gh-merge-menu' }, ...items))
      }
      break
    }
    case 'pr-merged':
      parts.push(h('span', { key: 'merged' }, catalog.mergedBanner(state.number)))
      break
  }
  if (notice !== undefined) parts.push(h('span', { key: 'notice', className: 'gh-notice' }, notice))
  return h('div', { className: 'gh-status-bar' }, ...parts)
}
