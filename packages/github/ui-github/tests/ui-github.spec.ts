// @vitest-environment jsdom
import { act, createElement as h, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceFlowPrompt, GitHubFlowState } from 'dsh-github-connect'
import {
  ConnectGitHubSection,
  MERGE_METHODS,
  PrStatusBar,
  catalogFor,
  connectErrorText,
  connectViewFromStatus,
  defaultTimers,
  installGitHubUi,
  reduceConnectView,
  sameFlowState,
  type ConnectView,
  type GitHubUiRemote,
  type GitHubUiShell,
  type StatusBarTimers,
  type UiLocale,
} from 'dsh-ui-github'
import * as uiInvariant from 'dsh-ui-github/invariant'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// —— shared helpers ———————————————————————————————————————————————————————————

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failed<T>(message: string): RemoteResult<T> {
  return { ok: false, error: { code: 'RPC_FAILED', message, details: {} } }
}

const PROMPT: DeviceFlowPrompt = {
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  interval: 5,
  expiresIn: 900,
}

const REPO = { owner: 'octo', repo: 'hello-world' }

const PR_READY: GitHubFlowState = { kind: 'pr-ready', repo: REPO, branch: 'feat/x', base: 'main', aheadCount: 3 }
const PR_OPEN: GitHubFlowState = { kind: 'pr-open', repo: REPO, branch: 'feat/x', number: 123, url: 'https://github.com/octo/hello-world/pull/123', ci: 'pending' }
const PR_OPEN_BARE: GitHubFlowState = { kind: 'pr-open', repo: REPO, branch: 'feat/x', number: 123 }
const PR_MERGED: GitHubFlowState = { kind: 'pr-merged', repo: REPO, branch: 'feat/x', number: 123 }

interface FakeRemote {
  readonly remote: GitHubUiRemote
  readonly calls: {
    connectStatus: ReturnType<typeof vi.fn>
    startDeviceFlow: ReturnType<typeof vi.fn>
    deviceFlowStatus: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    createPr: ReturnType<typeof vi.fn>
    mergePr: ReturnType<typeof vi.fn>
    prChecks: ReturnType<typeof vi.fn>
    refreshFlowState: ReturnType<typeof vi.fn>
  }
  emit(event: string, ...args: unknown[]): void
  listenerCount(): number
}

function fakeRemote(): FakeRemote {
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const calls = {
    connectStatus: vi.fn(async () => ok({ connected: false })),
    startDeviceFlow: vi.fn(async () => ok(PROMPT)),
    deviceFlowStatus: vi.fn(async () => ok(undefined)),
    disconnect: vi.fn(async () => ok(undefined)),
    createPr: vi.fn(async () => ok({ number: 123, created: true, head: 'feat/x', base: 'main' })),
    mergePr: vi.fn(async () => ok({ merged: true, sha: 'abc' })),
    prChecks: vi.fn(async () => ok('passing')),
    refreshFlowState: vi.fn(async () => ok({ kind: 'hidden' })),
  }
  const remote = {
    githubConnect: calls,
    $on: (event: string, listener: (...args: never[]) => void) => {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
      return () => bucket.delete(listener)
    },
  } as unknown as GitHubUiRemote
  return {
    remote,
    calls,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args)
    },
    listenerCount: () => [...listeners.values()].reduce((sum, bucket) => sum + bucket.size, 0),
  }
}

interface FakeShell {
  readonly shell: GitHubUiShell
  readonly prompts: string[]
  readonly opened: string[]
  readonly copied: string[]
  readonly confirms: string[]
  readonly slots: Map<string, () => ReactNode>
  setVisible(visible: boolean): void
  setConfirm(answer: boolean): void
}

function fakeShell(): FakeShell {
  const prompts: string[] = []
  const opened: string[] = []
  const copied: string[] = []
  const confirms: string[] = []
  const slots = new Map<string, () => ReactNode>()
  const visibilityListeners = new Set<(visible: boolean) => void>()
  let visible = true
  let confirmAnswer = true
  const shell: GitHubUiShell = {
    registerSlot: (slot, render) => {
      slots.set(slot, render)
      return () => void slots.delete(slot)
    },
    prompt: text => void prompts.push(text),
    openExternal: url => void opened.push(url),
    copyText: async text => void copied.push(text),
    confirmIrreversible: async question => {
      confirms.push(question)
      return confirmAnswer
    },
    visibility: {
      visible: () => visible,
      onChange: listener => {
        visibilityListeners.add(listener)
        return () => void visibilityListeners.delete(listener)
      },
    },
  }
  return {
    shell,
    prompts,
    opened,
    copied,
    confirms,
    slots,
    setVisible: next => {
      visible = next
      for (const listener of visibilityListeners) listener(next)
    },
    setConfirm: answer => void (confirmAnswer = answer),
  }
}

interface ManualTimers {
  readonly timers: StatusBarTimers
  readonly delays: number[]
  pendingCount(): number
  fire(): Promise<void>
}

function manualTimers(): ManualTimers {
  let sequence = 0
  const pending = new Map<number, { fn: () => void, ms: number }>()
  const delays: number[] = []
  return {
    timers: {
      setTimeout: (fn, ms) => {
        // An infinite delay never fires and never records: it is how
        // CI-focused tests park the flow-state poller (IDLE_POLL) without
        // polluting the delay assertions.
        if (!Number.isFinite(ms)) return 0
        delays.push(ms)
        const id = ++sequence
        pending.set(id, { fn, ms })
        return id
      },
      clearTimeout: handle => void pending.delete(handle as number),
    },
    delays,
    pendingCount: () => pending.size,
    fire: async () => {
      // Soonest first (ties: oldest), matching what real timers would run.
      const [id, entry] = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0]!
      pending.delete(id)
      await act(async () => {
        entry.fn()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    },
  }
}

/** Parks a poller: never fires, never recorded by {@link manualTimers}. */
const IDLE_POLL = { initialMs: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY }

const roots: { root: Root, container: HTMLElement }[] = []

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(element)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return container
}

async function unmountAll(): Promise<void> {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
}

afterEach(unmountAll)

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')!
  await act(async () => {
    descriptor.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(container: HTMLElement, text: string): Element {
  const hit = [...container.querySelectorAll('button')].find(button => button.textContent === text)
  expect(hit, `button "${text}"`).toBeDefined()
  return hit!
}

/**
 * Drive the bar into a state through the polling path (ADR-0009): point the
 * refresh mock at the state, then use the credentials/updated listener's
 * immediate re-sync as the deterministic trigger.
 */
async function adoptState(suite: FakeRemote, state: GitHubFlowState): Promise<void> {
  suite.calls.refreshFlowState.mockResolvedValue(ok(state))
  await act(async () => {
    suite.emit('credentials/updated', 'GITHUB_TOKEN')
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

// —— i18n ————————————————————————————————————————————————————————————————————

describe('catalogs', () => {
  it('pairs every string across both locales', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const catalog = catalogFor(locale)
      expect(catalog.connectLoading).not.toBe('')
      expect(catalog.connectButton).not.toBe('')
      expect(catalog.connectedAs('octocat')).toContain('@octocat')
      expect(catalog.connectedAnonymous).not.toBe('')
      expect(catalog.disconnectButton).not.toBe('')
      expect(catalog.waitingForAuthorization('ABCD-1234')).toContain('ABCD-1234')
      expect(catalog.deviceExpired).not.toBe('')
      expect(catalog.deviceDenied).not.toBe('')
      expect(catalog.deviceFailed('boom')).toContain('boom')
      expect(catalog.retryButton).not.toBe('')
      expect(catalog.aheadOfBase('feat/x', 'main', 1)).toContain('feat/x')
      expect(catalog.aheadOfBase('feat/x', 'main', 3)).toContain('3')
      expect(catalog.createPrButton).not.toBe('')
      expect(catalog.prTitlePlaceholder).not.toBe('')
      expect(catalog.prBodyPlaceholder).not.toBe('')
      expect(catalog.confirmCreateButton).not.toBe('')
      expect(catalog.openPr(123)).toBe('#123')
      expect(catalog.ciBadge('pending')).not.toBe('')
      expect(catalog.ciBadge('passing')).not.toBe('')
      expect(catalog.ciBadge('failing')).not.toBe('')
      expect(catalog.reviewButton).not.toBe('')
      expect(catalog.reviewPrompt(123)).toContain('#123')
      expect(catalog.mergeButton).not.toBe('')
      expect(catalog.mergeMethodLabel('squash')).toBe('Squash')
      expect(catalog.mergeMethodLabel('merge')).toBe('Merge commit')
      expect(catalog.mergeMethodLabel('rebase')).toBe('Rebase')
      expect(catalog.openOnGitHub).not.toBe('')
      expect(catalog.mergeConfirm(123, 'Squash')).toContain('#123')
      expect(catalog.mergeFailed('boom')).toContain('boom')
      expect(catalog.mergedBanner(123)).toContain('#123')
    }
    expect(catalogFor('zh-CN').connectButton).toBe('连接 GitHub')
    expect(catalogFor('en').aheadOfBase('b', 'm', 1)).toContain('1 commit')
    expect(catalogFor('en').aheadOfBase('b', 'm', 2)).toContain('2 commits')
  })
})

// —— view models ——————————————————————————————————————————————————————————————

describe('connect view model', () => {
  it('folds status results into the section view', () => {
    expect(connectViewFromStatus(failed('down'))).toEqual({ kind: 'error', reason: 'failed', message: 'down' })
    expect(connectViewFromStatus(ok({ connected: false }))).toEqual({ kind: 'disconnected' })
    expect(connectViewFromStatus(ok({ connected: true }))).toEqual({ kind: 'connected' })
    expect(connectViewFromStatus(ok({ connected: true, login: 'octocat' }))).toEqual({ kind: 'connected', login: 'octocat' })
  })

  it('advances on device-flow updates, keeping the view on slow-down', () => {
    const waiting: ConnectView = { kind: 'waiting', userCode: 'A', verificationUri: 'https://x' }
    expect(reduceConnectView({ kind: 'loading' }, { phase: 'awaiting-authorization', prompt: PROMPT }))
      .toEqual({ kind: 'waiting', userCode: PROMPT.userCode, verificationUri: PROMPT.verificationUri })
    expect(reduceConnectView(waiting, { phase: 'slow-down', intervalSeconds: 10 })).toBe(waiting)
    expect(reduceConnectView(waiting, { phase: 'authorized' })).toEqual({ kind: 'loading' })
    expect(reduceConnectView(waiting, { phase: 'expired' })).toEqual({ kind: 'error', reason: 'expired' })
    expect(reduceConnectView(waiting, { phase: 'denied' })).toEqual({ kind: 'error', reason: 'denied' })
    expect(reduceConnectView(waiting, { phase: 'failed', message: 'boom' })).toEqual({ kind: 'error', reason: 'failed', message: 'boom' })
  })

  it('localizes every error reason, tolerating an absent message', () => {
    const catalog = catalogFor('en')
    expect(connectErrorText({ kind: 'error', reason: 'expired' }, catalog)).toBe(catalog.deviceExpired)
    expect(connectErrorText({ kind: 'error', reason: 'denied' }, catalog)).toBe(catalog.deviceDenied)
    expect(connectErrorText({ kind: 'error', reason: 'failed', message: 'boom' }, catalog)).toContain('boom')
    expect(connectErrorText({ kind: 'error', reason: 'failed' }, catalog)).toBe(catalog.deviceFailed(''))
  })

  it('freezes the merge strategy order', () => {
    expect(MERGE_METHODS).toEqual(['squash', 'merge', 'rebase'])
    expect(Object.isFrozen(MERGE_METHODS)).toBe(true)
  })

  it('compares flow states field by field, ignoring only the CI rollup', () => {
    expect(sameFlowState({ kind: 'hidden' }, { kind: 'hidden' })).toBe(true)
    expect(sameFlowState({ kind: 'hidden' }, PR_READY)).toBe(false)
    expect(sameFlowState(PR_READY, { ...PR_READY })).toBe(true)
    expect(sameFlowState(PR_READY, { ...PR_READY, aheadCount: 4 })).toBe(false)
    expect(sameFlowState(PR_READY, { ...PR_READY, base: 'dev' })).toBe(false)
    expect(sameFlowState(PR_READY, { ...PR_READY, branch: 'other' })).toBe(false)
    expect(sameFlowState(PR_OPEN, { ...PR_OPEN, ci: 'passing' })).toBe(true)
    expect(sameFlowState(PR_OPEN, { ...PR_OPEN, number: 124 })).toBe(false)
    expect(sameFlowState(PR_OPEN, PR_OPEN_BARE)).toBe(false)
    expect(sameFlowState(PR_OPEN, { ...PR_OPEN, branch: 'other' })).toBe(false)
    expect(sameFlowState(PR_MERGED, { ...PR_MERGED })).toBe(true)
    expect(sameFlowState(PR_MERGED, { ...PR_MERGED, number: 124 })).toBe(false)
    expect(sameFlowState(PR_MERGED, { ...PR_MERGED, branch: 'other' })).toBe(false)
  })
})

// —— settings section —————————————————————————————————————————————————————————

interface SectionOptions {
  locale?: UiLocale
  timers?: StatusBarTimers
}

function section(suite: FakeRemote, shell: FakeShell, options: SectionOptions = {}): ReactElement {
  return h(ConnectGitHubSection, { remote: suite.remote, shell: shell.shell, ...options })
}

describe('ConnectGitHubSection', () => {
  it('renders disconnected after the initial status query', async () => {
    const suite = fakeRemote()
    const container = await mount(section(suite, fakeShell()))
    expect(container.textContent).toContain(catalogFor('en').connectButton)
    expect(suite.calls.connectStatus).toHaveBeenCalledTimes(1)
  })

  it('renders the connected login, or the anonymous label without one', async () => {
    const named = fakeRemote()
    named.calls.connectStatus.mockResolvedValue(ok({ connected: true, login: 'octocat' }))
    const namedContainer = await mount(section(named, fakeShell()))
    expect(namedContainer.textContent).toContain('Connected as @octocat')

    const anonymous = fakeRemote()
    anonymous.calls.connectStatus.mockResolvedValue(ok({ connected: true }))
    const anonymousContainer = await mount(section(anonymous, fakeShell()))
    expect(anonymousContainer.textContent).toContain(catalogFor('en').connectedAnonymous)
  })

  it('walks connect → waiting → authorized → connected through the status poll', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const container = await mount(section(suite, shell, { timers: clock.timers }))
    await click(buttonByText(container, 'Connect GitHub'))
    expect(shell.copied).toEqual([PROMPT.userCode])
    expect(shell.opened).toEqual([PROMPT.verificationUri])
    expect(container.textContent).toContain(PROMPT.userCode)
    // The poll paces at the prompt's server-dictated interval (5s).
    expect(clock.delays).toEqual([5000])

    // Nothing reported yet (undefined) keeps waiting.
    await clock.fire()
    expect(container.textContent).toContain(PROMPT.userCode)

    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'awaiting-authorization', prompt: PROMPT }))
    await clock.fire()
    expect(container.textContent).toContain(PROMPT.userCode)

    // slow-down stretches the pacing without changing the view.
    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'slow-down', intervalSeconds: 10 }))
    await clock.fire()
    expect(container.textContent).toContain(PROMPT.userCode)
    expect(clock.delays).toEqual([5000, 5000, 5000, 10_000])

    suite.calls.connectStatus.mockResolvedValue(ok({ connected: true, login: 'octocat' }))
    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'authorized' }))
    await clock.fire()
    expect(container.textContent).toContain('Connected as @octocat')
    // Leaving the waiting view tears the poll down.
    expect(clock.pendingCount()).toBe(0)
  })

  it('keeps waiting through a transient status-poll failure', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(section(suite, fakeShell(), { timers: clock.timers }))
    await click(buttonByText(container, 'Connect GitHub'))
    suite.calls.deviceFlowStatus.mockResolvedValue(failed('gateway down'))
    await clock.fire()
    expect(container.textContent).toContain(PROMPT.userCode)
    expect(clock.pendingCount()).toBe(1)
  })

  it('drops a status poll that lands after unmount', async () => {
    const suite = fakeRemote()
    let resolvePoll: (value: RemoteResult<unknown>) => void = () => {}
    suite.calls.deviceFlowStatus.mockImplementation(() => new Promise(resolve => {
      resolvePoll = resolve
    }))
    const clock = manualTimers()
    const container = await mount(section(suite, fakeShell(), { timers: clock.timers }))
    await click(buttonByText(container, 'Connect GitHub'))
    await clock.fire()
    await unmountAll()
    resolvePoll(ok({ phase: 'authorized' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    // The disposed tick neither reschedules nor re-queries the status.
    expect(clock.pendingCount()).toBe(0)
    expect(suite.calls.connectStatus).toHaveBeenCalledTimes(1)
  })

  it('surfaces a startDeviceFlow refusal with a retry path', async () => {
    const suite = fakeRemote()
    suite.calls.startDeviceFlow.mockResolvedValue(failed('no clientId'))
    const container = await mount(section(suite, fakeShell()))
    await click(buttonByText(container, 'Connect GitHub'))
    expect(container.textContent).toContain('no clientId')

    suite.calls.startDeviceFlow.mockResolvedValue(ok(PROMPT))
    await click(buttonByText(container, 'Retry'))
    expect(container.textContent).toContain(PROMPT.userCode)
  })

  it('reaches denied, expired, and failed terminal phases through the poll', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(section(suite, fakeShell(), { timers: clock.timers }))
    await click(buttonByText(container, 'Connect GitHub'))
    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'denied' }))
    await clock.fire()
    expect(container.textContent).toContain(catalogFor('en').deviceDenied)

    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'expired' }))
    await click(buttonByText(container, 'Retry'))
    await clock.fire()
    expect(container.textContent).toContain(catalogFor('en').deviceExpired)

    suite.calls.deviceFlowStatus.mockResolvedValue(ok({ phase: 'failed', message: 'boom' }))
    await click(buttonByText(container, 'Retry'))
    await clock.fire()
    expect(container.textContent).toContain('boom')
  })

  it('maps an errored status query to the error view', async () => {
    const suite = fakeRemote()
    suite.calls.connectStatus.mockResolvedValue(failed('gateway down'))
    const container = await mount(section(suite, fakeShell()))
    expect(container.textContent).toContain('gateway down')
  })

  it('re-queries on credentials/updated and disconnects on the button', async () => {
    const suite = fakeRemote()
    suite.calls.connectStatus.mockResolvedValue(ok({ connected: true, login: 'octocat' }))
    const container = await mount(section(suite, fakeShell()))
    expect(container.textContent).toContain('@octocat')

    await click(buttonByText(container, 'Disconnect'))
    expect(suite.calls.disconnect).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(catalogFor('en').connectButton)

    suite.calls.connectStatus.mockResolvedValue(ok({ connected: true, login: 'hubot' }))
    await act(async () => {
      suite.emit('credentials/updated', 'GITHUB_TOKEN')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('@hubot')
  })

  it('renders the zh-CN catalog and disposes the credentials listener on unmount', async () => {
    const suite = fakeRemote()
    const container = await mount(section(suite, fakeShell(), { locale: 'zh-CN' }))
    expect(container.textContent).toContain('连接 GitHub')
    expect(suite.listenerCount()).toBe(1)
    await unmountAll()
    expect(suite.listenerCount()).toBe(0)
  })
})

// —— status bar ———————————————————————————————————————————————————————————————

interface BarOptions {
  locale?: UiLocale
  poll?: { initialMs: number, maxMs: number }
  flowPoll?: { initialMs: number, maxMs: number }
  collapseMs?: number
  timers?: StatusBarTimers
}

/** Mounts the bar with the flow poller parked unless a test drives it. */
function bar(suite: FakeRemote, shell: FakeShell, options: BarOptions = {}): ReactElement {
  return h(PrStatusBar, { remote: suite.remote, shell: shell.shell, flowPoll: IDLE_POLL, ...options })
}

describe('PrStatusBar', () => {
  it('walks the four states end to end and collapses after the merge banner', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const container = await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, collapseMs: 100, timers: clock.timers }))
    expect(suite.calls.refreshFlowState).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')

    await adoptState(suite, PR_READY)
    expect(container.textContent).toContain('feat/x is ahead of main by 3 commits')

    await adoptState(suite, PR_OPEN)
    expect(container.querySelector('a')!.getAttribute('href')).toBe(PR_OPEN.kind === 'pr-open' ? PR_OPEN.url : '')
    expect(container.textContent).toContain('#123')
    expect(container.textContent).toContain('CI running')

    await adoptState(suite, PR_MERGED)
    expect(container.textContent).toContain('#123 merged')
    await clock.fire()
    expect(container.textContent).toBe('')
  })

  it('keeps the last state when the mount-time refresh fails', async () => {
    const suite = fakeRemote()
    suite.calls.refreshFlowState.mockResolvedValue(failed('gateway down'))
    const container = await mount(bar(suite, fakeShell(), { timers: manualTimers().timers }))
    expect(container.textContent).toBe('')
  })

  it('adopts the refreshed state on mount when one exists', async () => {
    const suite = fakeRemote()
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_READY))
    const container = await mount(bar(suite, fakeShell(), { timers: manualTimers().timers }))
    expect(container.textContent).toContain('feat/x is ahead of main by 3 commits')
  })

  it('creates a PR from the edited form and adopts the refreshed state', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const container = await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_READY)

    await click(buttonByText(container, 'Create PR'))
    await click(buttonByText(container, 'Create PR'))
    expect(container.querySelector('input')).toBeNull()
    await click(buttonByText(container, 'Create PR'))
    await setValue(container.querySelector('input')!, 'feat: add x')
    await setValue(container.querySelector('textarea')!, 'Adds x end to end.')
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_OPEN))
    await click(buttonByText(container, 'Confirm'))
    expect(suite.calls.createPr).toHaveBeenCalledWith({ title: 'feat: add x', body: 'Adds x end to end.' })
    expect(container.textContent).toContain('#123')
  })

  it('falls back to the branch name as the title and omits an empty body', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_READY)
    await click(buttonByText(container, 'Create PR'))
    await click(buttonByText(container, 'Confirm'))
    expect(suite.calls.createPr).toHaveBeenCalledWith({ title: 'feat/x' })
  })

  it('shows a creation refusal in place and keeps the bar interactive', async () => {
    const suite = fakeRemote()
    suite.calls.createPr.mockResolvedValue(failed('validation failed'))
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_READY)
    await click(buttonByText(container, 'Create PR'))
    await click(buttonByText(container, 'Confirm'))
    expect(container.textContent).toContain('validation failed')
    expect(container.textContent).toContain('feat/x is ahead of main')
  })

  it('keeps the current state when the post-create refresh fails', async () => {
    const suite = fakeRemote()
    suite.calls.refreshFlowState
      .mockResolvedValueOnce(ok({ kind: 'hidden' }))
      .mockResolvedValue(failed('gateway down'))
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_READY)
    await click(buttonByText(container, 'Create PR'))
    await click(buttonByText(container, 'Confirm'))
    expect(suite.calls.createPr).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('feat/x is ahead of main')
  })

  it('renders a plain PR label and no external link without a URL', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN_BARE)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('#123')
    await click(buttonByText(container, 'Merge'))
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).not.toContain('Open on GitHub')
  })

  it('polls the CI badge with backoff and folds refusals to no change', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 25 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN_BARE)
    expect(container.textContent).not.toContain('CI')

    await clock.fire()
    expect(container.textContent).toContain('CI passing')
    suite.calls.prChecks.mockResolvedValue(failed('rate limited'))
    await clock.fire()
    expect(container.textContent).toContain('CI passing')
    await clock.fire()
    expect(clock.delays).toEqual([10, 20, 25, 25])
  })

  it('pauses the poller while hidden and resumes at the initial pace', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)
    await clock.fire()
    expect(clock.delays).toEqual([10, 20])

    await act(async () => shell.setVisible(false))
    expect(clock.pendingCount()).toBe(0)
    await act(async () => shell.setVisible(true))
    expect(clock.delays).toEqual([10, 20, 10])
  })

  it('never schedules while mounted hidden', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    shell.setVisible(false)
    const clock = manualTimers()
    await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)
    expect(clock.pendingCount()).toBe(0)
  })

  it('drops a poll result that lands after unmount', async () => {
    const suite = fakeRemote()
    let resolveChecks: (value: RemoteResult<unknown>) => void = () => {}
    suite.calls.prChecks.mockImplementation(() => new Promise(resolve => {
      resolveChecks = resolve
    }))
    const clock = manualTimers()
    await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)
    await clock.fire()
    expect(suite.calls.prChecks).toHaveBeenCalledTimes(1)
    await unmountAll()
    resolveChecks(ok('failing'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clock.pendingCount()).toBe(0)
  })

  it('sends the review prompt through the shell — the one model-turn button', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const container = await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)
    await click(buttonByText(container, 'AI review'))
    expect(shell.prompts).toEqual([catalogFor('en').reviewPrompt(123)])
  })

  it('merges through confirmation and adopts the merged state', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const container = await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)

    await click(buttonByText(container, 'Merge'))
    await click(buttonByText(container, 'Merge'))
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).not.toContain('Squash')
    await click(buttonByText(container, 'Merge'))
    await click(buttonByText(container, 'Open on GitHub'))
    expect(shell.opened).toEqual([PR_OPEN.kind === 'pr-open' ? PR_OPEN.url : ''])

    // Opening the PR page keeps the dropdown open, so [Squash] is clickable.
    shell.setConfirm(false)
    await click(buttonByText(container, 'Squash'))
    expect(suite.calls.mergePr).not.toHaveBeenCalled()

    shell.setConfirm(true)
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_MERGED))
    await click(buttonByText(container, 'Merge'))
    await click(buttonByText(container, 'Squash'))
    expect(shell.confirms.at(-1)).toContain('#123')
    expect(suite.calls.mergePr).toHaveBeenCalledWith({ number: 123, method: 'squash' })
    expect(container.textContent).toContain('#123 merged')
  })

  it('shows a merge refusal in place and survives a failed post-merge refresh', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    suite.calls.mergePr.mockResolvedValueOnce(failed('blocked by branch protection'))
    const container = await mount(bar(suite, shell, { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_OPEN)
    await click(buttonByText(container, 'Merge'))
    await click(buttonByText(container, 'Rebase'))
    expect(container.textContent).toContain('blocked by branch protection')

    suite.calls.refreshFlowState.mockResolvedValue(failed('gateway down'))
    await click(buttonByText(container, 'Merge'))
    await click(buttonByText(container, 'Rebase'))
    expect(suite.calls.mergePr).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('#123')
  })

  it('disappears immediately after disconnect (credentials/updated → hidden)', async () => {
    const suite = fakeRemote()
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_OPEN))
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    expect(container.textContent).toContain('#123')

    suite.calls.refreshFlowState.mockResolvedValue(ok({ kind: 'hidden' }))
    await act(async () => {
      suite.emit('credentials/updated', 'GITHUB_TOKEN')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(container.textContent).toBe('')
  })

  it('renders the zh-CN catalog', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), { locale: 'zh-CN', poll: { initialMs: 10, maxMs: 40 }, timers: clock.timers }))
    await adoptState(suite, PR_READY)
    expect(container.textContent).toContain('feat/x 领先 main 3 个提交')
    expect(container.textContent).toContain('创建 PR')
  })

  it('collapses through the real default timers', async () => {
    const suite = fakeRemote()
    const container = await mount(bar(suite, fakeShell(), { collapseMs: 10, flowPoll: { initialMs: 60_000, maxMs: 60_000 }, timers: defaultTimers }))
    await adoptState(suite, PR_MERGED)
    expect(container.textContent).toContain('#123 merged')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(container.textContent).toBe('')
  })

  it('uses the built-in defaults when no knobs are passed', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    // Deliberately NOT the bar() helper: every default (poll, flow poll,
    // collapse, timers) must resolve from the component itself.
    const container = await mount(h(PrStatusBar, { remote: suite.remote, shell: shell.shell }))
    await adoptState(suite, PR_MERGED)
    expect(container.textContent).toContain('#123 merged')
  })

  it('surfaces a state transition through the flow poller with backoff', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), {
      flowPoll: { initialMs: 100, maxMs: 400 },
      poll: IDLE_POLL,
      timers: clock.timers,
    }))
    expect(container.textContent).toBe('')
    expect(clock.delays).toEqual([100])

    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_READY))
    await clock.fire()
    expect(container.textContent).toContain('feat/x is ahead of main by 3 commits')
    await clock.fire()
    await clock.fire()
    expect(clock.delays).toEqual([100, 200, 400, 400])
  })

  it('keeps an open draft on an unchanged poll and folds a CI change into the badge', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    const container = await mount(bar(suite, fakeShell(), {
      flowPoll: { initialMs: 100, maxMs: 100 },
      poll: IDLE_POLL,
      timers: clock.timers,
    }))
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_READY))
    await clock.fire()
    await click(buttonByText(container, 'Create PR'))
    await setValue(container.querySelector('input')!, 'feat: draft in progress')

    // Same state again: the dropdown and the draft survive the poll.
    await clock.fire()
    expect(container.querySelector('input')!.value).toBe('feat: draft in progress')

    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_OPEN_BARE))
    await clock.fire()
    expect(container.textContent).toContain('#123')
    expect(container.textContent).not.toContain('CI')

    // Unchanged pr-open with no rollup leaves the badge alone …
    await clock.fire()
    expect(container.textContent).not.toContain('CI')
    // … and an unchanged pr-open WITH a rollup updates only the badge.
    suite.calls.refreshFlowState.mockResolvedValue(ok({ ...PR_OPEN_BARE, ci: 'passing' }))
    await clock.fire()
    expect(container.textContent).toContain('CI passing')
  })

  it('drops a flow poll that lands after unmount', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    await mount(bar(suite, fakeShell(), {
      flowPoll: { initialMs: 100, maxMs: 100 },
      poll: IDLE_POLL,
      timers: clock.timers,
    }))
    let resolveRefresh: (value: RemoteResult<unknown>) => void = () => {}
    suite.calls.refreshFlowState.mockImplementation(() => new Promise(resolve => {
      resolveRefresh = resolve
    }))
    await clock.fire()
    await unmountAll()
    resolveRefresh(failed('late'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clock.pendingCount()).toBe(0)
  })

  it('does not resurrect the merged banner after it collapses', async () => {
    const suite = fakeRemote()
    const clock = manualTimers()
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_MERGED))
    const container = await mount(bar(suite, fakeShell(), {
      flowPoll: { initialMs: 100, maxMs: 100 },
      poll: IDLE_POLL,
      collapseMs: 50,
      timers: clock.timers,
    }))
    expect(container.textContent).toContain('#123 merged')

    // The collapse (50ms) beats the next poll (100ms).
    await clock.fire()
    expect(container.textContent).toBe('')
    // The host still detects pr-merged; the collapsed banner stays down.
    await clock.fire()
    expect(container.textContent).toBe('')

    // A real transition clears the memory …
    suite.calls.refreshFlowState.mockResolvedValue(ok(PR_READY))
    await clock.fire()
    expect(container.textContent).toContain('feat/x is ahead')
    // … so a DIFFERENT merge shows its banner again.
    suite.calls.refreshFlowState.mockResolvedValue(ok({ ...PR_MERGED, number: 124 }))
    await clock.fire()
    expect(container.textContent).toContain('#124 merged')
  })
})

// —— install ——————————————————————————————————————————————————————————————————

describe('installGitHubUi', () => {
  it('registers both slots, renders them, and unregisters on dispose', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const dispose = installGitHubUi(shell.shell, suite.remote)
    expect([...shell.slots.keys()]).toEqual(['settings.section', 'conversation.input.dock'])

    const sectionContainer = await mount(shell.slots.get('settings.section')!() as ReactElement)
    expect(sectionContainer.textContent).toContain('Connect GitHub')
    const dockContainer = await mount(shell.slots.get('conversation.input.dock')!() as ReactElement)
    await adoptState(suite, PR_MERGED)
    expect(dockContainer.textContent).toContain('#123 merged')
    await unmountAll()

    dispose()
    expect(shell.slots.size).toBe(0)
  })

  it('threads every option through to both components', async () => {
    const suite = fakeRemote()
    const shell = fakeShell()
    const clock = manualTimers()
    const dispose = installGitHubUi(shell.shell, suite.remote, {
      locale: 'zh-CN',
      poll: { initialMs: 10, maxMs: 40 },
      flowPoll: IDLE_POLL,
      collapseMs: 100,
      timers: clock.timers,
    })
    const sectionContainer = await mount(shell.slots.get('settings.section')!() as ReactElement)
    expect(sectionContainer.textContent).toContain('连接 GitHub')
    const dockContainer = await mount(shell.slots.get('conversation.input.dock')!() as ReactElement)
    await adoptState(suite, PR_MERGED)
    expect(dockContainer.textContent).toContain('#123 已合并')
    await clock.fire()
    expect(dockContainer.textContent).toBe('')
    dispose()
  })
})

// —— invariant companion ——————————————————————————————————————————————————————

describe('dsh-ui-github invariant companion', () => {
  it('registers with the invariant service and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, {})
    expect(uiInvariant.name).toBe('ui-github-invariant')
    expect(uiInvariant.inject).toEqual(['invariants'])
    const dispose = await uiInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
