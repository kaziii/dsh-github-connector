// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { ConnectGitHubSection, PrStatusBar } from 'dsh-ui-github'
import type { GitHubUiRemote } from '../src/types.ts'
import { GITHUB_CONNECT_REMOTE } from '../src/client/contribution.ts'
import { apply, detectLocale, inject, name } from '../src/client/index.ts'
import { createBrowserShell } from '../src/client/shell.ts'
import { STYLE_MARKER, STYLE_TEXT, installStyles } from '../src/client/styles.ts'

// —— fakes ————————————————————————————————————————————————————————————————————

interface FakeRegistration {
  options: { name: string, id: string, order: number }
  component: (props: { sessionId?: string }) => unknown
}

function fakeClientCtx() {
  const injected: string[] = []
  const registrations: FakeRegistration[] = []
  const sends: { sessionId: string, text: string }[] = []
  const raw = {
    slots: {
      inject: vi.fn((key: string, callback: () => () => void) => {
        injected.push(key)
        const dispose = callback()
        return dispose
      }),
      register: vi.fn((options: FakeRegistration['options'], component: FakeRegistration['component']) => {
        const registration = { options, component }
        registrations.push(registration)
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
      }),
    },
    sessions: {
      scope: (sessionId: string) => ({
        conversation: { send: async (text: string) => void sends.push({ sessionId, text }) },
      }),
    },
    remote: {
      $mount: vi.fn(async () => async () => {}),
      $on: vi.fn(() => () => {}),
    },
    namespace: { marker: 'githubConnect-namespace' },
    get: vi.fn((key: string) => key === 'remote.githubConnect' ? raw.namespace : undefined),
    effect: vi.fn((callback: () => () => void) => callback()),
  }
  return { ctx: raw as unknown as Context, raw, injected, registrations, sends }
}

function descriptor(method: string): InvocationDescriptor {
  const hit = GITHUB_CONNECT_REMOTE.descriptors.find(entry => entry.method === method)
  expect(hit, `descriptor ${method}`).toBeDefined()
  return hit!
}

function parseOf(codec: InvocationDescriptor['result']): (value: unknown) => unknown {
  if (codec.mode !== 'strict') throw new Error('expected a strict codec')
  return value => codec.schema.parse(value)
}

// —— contribution —————————————————————————————————————————————————————————————

describe('GITHUB_CONNECT_REMOTE', () => {
  it('mirrors every @Remote method of GitHubConnectService, all strict and direct', () => {
    expect(GITHUB_CONNECT_REMOTE.package).toBe('dsh-github-connect')
    expect(GITHUB_CONNECT_REMOTE.descriptors.map(entry => entry.method).sort()).toEqual([
      'connectStatus',
      'createPr',
      'deviceFlowStatus',
      'disconnect',
      'mergePr',
      'prChecks',
      'prDraft',
      'refreshFlowState',
      'startDeviceFlow',
    ])
    for (const entry of GITHUB_CONNECT_REMOTE.descriptors) {
      expect(entry.id).toBe(`dsh-github-connect#githubConnect/${entry.method}`)
      expect(entry.service).toBe('githubConnect')
      expect(entry.namespace).toBe('githubConnect')
      expect(entry.invocation).toEqual({ kind: 'direct' })
      expect(entry.result.mode).toBe('strict')
      for (const parameter of entry.parameters) {
        // SRC wire fields derive from the host formal parameter names.
        expect(parameter.wire).toBe(parameter.name)
        expect(parameter.source).toBe('json')
        expect(parameter.codec.mode).toBe('strict')
      }
    }
  })

  it('validates object results and refuses non-objects', () => {
    for (const method of ['connectStatus', 'startDeviceFlow', 'refreshFlowState'] as const) {
      const parse = parseOf(descriptor(method).result)
      const value = { probe: method }
      expect(parse(value)).toBe(value)
      expect(() => parse('nope')).toThrow(TypeError)
      expect(() => parse(null)).toThrow(TypeError)
    }
  })

  it('treats absent optional results as undefined', () => {
    const flowStatus = parseOf(descriptor('deviceFlowStatus').result)
    expect(flowStatus(undefined)).toBeUndefined()
    expect(flowStatus(null)).toBeUndefined()
    const update = { phase: 'authorized' }
    expect(flowStatus(update)).toBe(update)
    expect(() => flowStatus(5)).toThrow(TypeError)

    const checks = parseOf(descriptor('prChecks').result)
    expect(checks(undefined)).toBeUndefined()
    expect(checks(null)).toBeUndefined()
    expect(checks('passing')).toBe('passing')
    expect(() => checks(5)).toThrow(TypeError)
  })

  it('accepts only empty disconnect results', () => {
    const parse = parseOf(descriptor('disconnect').result)
    expect(parse(undefined)).toBeUndefined()
    expect(parse(null)).toBeUndefined()
    expect(() => parse({})).toThrow(TypeError)
  })

  it('gates the PR draft on a string title', () => {
    const parse = parseOf(descriptor('prDraft').result)
    const draft = { title: 'feat: x', body: '- a\n- b' }
    expect(parse(draft)).toBe(draft)
    expect(() => parse({ title: 5 })).toThrow(TypeError)
    expect(() => parse('feat: x')).toThrow(TypeError)
  })

  it('gates the createPr and mergePr requests on their required fields', () => {
    const createPr = parseOf(descriptor('createPr').parameters[0]!.codec)
    expect(createPr({ title: 'feat: x' })).toEqual({ title: 'feat: x' })
    expect(() => createPr({ title: 5 })).toThrow(TypeError)
    expect(() => createPr('feat: x')).toThrow(TypeError)
    expect(parseOf(descriptor('createPr').result)({ number: 1 })).toEqual({ number: 1 })

    const mergePr = parseOf(descriptor('mergePr').parameters[0]!.codec)
    expect(mergePr({ number: 1, method: 'squash' })).toEqual({ number: 1, method: 'squash' })
    expect(() => mergePr({ number: '1', method: 'squash' })).toThrow(TypeError)
    expect(() => mergePr({ number: 1 })).toThrow(TypeError)
    expect(parseOf(descriptor('mergePr').result)({ merged: true })).toEqual({ merged: true })

    const prNumber = parseOf(descriptor('prChecks').parameters[0]!.codec)
    expect(prNumber(5)).toBe(5)
    expect(() => prNumber('5')).toThrow(TypeError)
  })

  it('carries the calling session on every git-touching request (ADR-0010)', () => {
    // The zero-business-argument methods took an optional session request.
    for (const method of ['prDraft', 'refreshFlowState'] as const) {
      const parameter = descriptor(method).parameters[0]!
      expect(parameter.wire).toBe('request')
      expect(parameter.acceptsUndefined).toBe(true)
      const parse = parseOf(parameter.codec)
      expect(parse(undefined)).toBeUndefined()
      expect(parse(null)).toBeUndefined()
      const bare = {}
      expect(parse(bare)).toBe(bare)
      const carried = { sessionId: 's1' }
      expect(parse(carried)).toBe(carried)
      expect(() => parse({ sessionId: 5 })).toThrow(TypeError)
      expect(() => parse('s1')).toThrow(TypeError)
    }

    // The button requests validate a present sessionId's shape only.
    const createPr = parseOf(descriptor('createPr').parameters[0]!.codec)
    expect(createPr({ title: 'feat: x', sessionId: 's1' })).toEqual({ title: 'feat: x', sessionId: 's1' })
    expect(() => createPr({ title: 'feat: x', sessionId: 5 })).toThrow(TypeError)
    const mergePr = parseOf(descriptor('mergePr').parameters[0]!.codec)
    expect(mergePr({ number: 1, method: 'squash', sessionId: 's1' })).toEqual({ number: 1, method: 'squash', sessionId: 's1' })
    expect(() => mergePr({ number: 1, method: 'squash', sessionId: 5 })).toThrow(TypeError)

    // prChecks grew a second, optional session parameter.
    const session = descriptor('prChecks').parameters[1]!
    expect(session.wire).toBe('sessionId')
    expect(session.acceptsUndefined).toBe(true)
    const parse = parseOf(session.codec)
    expect(parse(undefined)).toBeUndefined()
    expect(parse(null)).toBeUndefined()
    expect(parse('s1')).toBe('s1')
    expect(() => parse(5)).toThrow(TypeError)
  })
})

// —— browser shell ————————————————————————————————————————————————————————————

describe('createBrowserShell', () => {
  it('narrows the settings slot to the plugin-config card and keeps the dock name', () => {
    const suite = fakeClientCtx()
    const shell = createBrowserShell(suite.ctx)
    shell.registerSlot('settings.section', () => 'card')
    shell.registerSlot('conversation.input.dock', () => 'dock')
    expect(suite.injected).toEqual(['settings.plugin.item', 'conversation.input.dock'])
    expect(suite.registrations.map(entry => entry.options)).toEqual([
      { name: 'settings.plugin.item', id: 'github', order: 30 },
      { name: 'conversation.input.dock', id: 'github', order: 30 },
    ])
    expect(suite.registrations[0]!.component({})).toBe('card')
  })

  it('prompts into the session the dock last rendered for, and nowhere before one', () => {
    const suite = fakeClientCtx()
    const shell = createBrowserShell(suite.ctx)
    shell.registerSlot('conversation.input.dock', () => 'dock')
    shell.prompt('too early')
    expect(suite.sends).toEqual([])
    expect(shell.sessionId()).toBeUndefined()
    suite.registrations[0]!.component({ sessionId: 's1' })
    shell.prompt('review PR #1')
    expect(suite.sends).toEqual([{ sessionId: 's1', text: 'review PR #1' }])
    // The same rendered-for session rides the Remote calls (ADR-0010).
    expect(shell.sessionId()).toBe('s1')
    // A sessionless render (root-scope pass) keeps the last session.
    suite.registrations[0]!.component({})
    shell.prompt('again')
    expect(suite.sends).toHaveLength(2)
    expect(shell.sessionId()).toBe('s1')
  })

  it('disposes a slot registration through the returned disposer', () => {
    const suite = fakeClientCtx()
    const shell = createBrowserShell(suite.ctx)
    const off = shell.registerSlot('settings.section', () => 'card')
    expect(suite.registrations).toHaveLength(1)
    off()
    expect(suite.registrations).toHaveLength(0)
  })

  it('opens only http(s) URLs in a new tab', () => {
    const shell = createBrowserShell(fakeClientCtx().ctx)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    shell.openExternal('https://github.com/login/device')
    expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank', 'noopener,noreferrer')
    shell.openExternal('javascript:alert(1)')
    shell.openExternal('file:///etc/passwd')
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('copies through the async clipboard and survives its absence', async () => {
    const shell = createBrowserShell(fakeClientCtx().ctx)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await shell.copyText('ABCD-1234')
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await expect(shell.copyText('ABCD-1234')).resolves.toBeUndefined()
  })

  it('confirms irreversible actions through the native dialog', async () => {
    const shell = createBrowserShell(fakeClientCtx().ctx)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(shell.confirmIrreversible('merge #1?')).resolves.toBe(true)
    confirm.mockReturnValue(false)
    await expect(shell.confirmIrreversible('merge #1?')).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('merge #1?')
    confirm.mockRestore()
  })

  it('mirrors document visibility and unsubscribes cleanly', () => {
    const shell = createBrowserShell(fakeClientCtx().ctx)
    let hidden = false
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true })
    expect(shell.visibility.visible()).toBe(true)
    const seen: boolean[] = []
    const off = shell.visibility.onChange(visible => void seen.push(visible))
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual([false, true])
    off()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toHaveLength(2)
  })
})

// —— stylesheet ———————————————————————————————————————————————————————————————

describe('installStyles', () => {
  it('installs once per document and removes on dispose', () => {
    const doc = document.implementation.createHTMLDocument()
    const off = installStyles(doc)
    const style = doc.head.querySelector(`style[${STYLE_MARKER}]`)
    expect(style).not.toBeNull()
    expect(style!.textContent).toBe(STYLE_TEXT)

    // A second install is a no-op whose disposer removes nothing.
    const noop = installStyles(doc)
    expect(doc.head.querySelectorAll('style')).toHaveLength(1)
    noop()
    expect(doc.head.querySelector(`style[${STYLE_MARKER}]`)).not.toBeNull()

    off()
    expect(doc.head.querySelector(`style[${STYLE_MARKER}]`)).toBeNull()
  })
})

// —— plugin entry —————————————————————————————————————————————————————————————

describe('client apply', () => {
  it('declares the plugin face without the self-mounted namespace', () => {
    expect(name).toBe('ui-github')
    expect(inject).toEqual(['remote', 'slots', 'sessions'])
    expect(inject).not.toContain('remote.githubConnect')
  })

  it('maps page languages to catalogs', () => {
    expect(detectLocale('zh')).toBe('zh-CN')
    expect(detectLocale('zh-CN')).toBe('zh-CN')
    expect(detectLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('zhx')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })

  it('mounts the contribution, then registers both surfaces with the page locale', async () => {
    const suite = fakeClientCtx()
    document.documentElement.lang = 'zh-CN'
    await apply(suite.ctx)
    expect(suite.raw.remote.$mount).toHaveBeenCalledWith(GITHUB_CONNECT_REMOTE)
    expect(suite.injected).toEqual(['settings.plugin.item', 'conversation.input.dock'])

    const card = suite.registrations[0]!.component({}) as ReactElement<{ locale: string }>
    expect(card.type).toBe(ConnectGitHubSection)
    expect(card.props.locale).toBe('zh-CN')
    const dock = suite.registrations[1]!.component({}) as ReactElement<{ locale: string }>
    expect(dock.type).toBe(PrStatusBar)

    // The stylesheet is the first effect; its disposer removes the element.
    expect(document.head.querySelector('style[data-dsh-ui-github]')).not.toBeNull()
    const disposeStyles = suite.raw.effect.mock.results[0]!.value as () => void
    disposeStyles()
    expect(document.head.querySelector('style[data-dsh-ui-github]')).toBeNull()

    // The install is an effect: its disposer unregisters both surfaces.
    const dispose = suite.raw.effect.mock.results[1]!.value as () => void
    dispose()
    expect(suite.registrations).toHaveLength(0)
    document.documentElement.lang = ''
  })

  it('hands the surfaces a remote face that resolves the namespace inject-free', async () => {
    const suite = fakeClientCtx()
    await apply(suite.ctx)
    const dock = suite.registrations[1]!.component({}) as ReactElement<{ remote: GitHubUiRemote }>
    const remote = dock.props.remote
    // The namespace is never the service-proxy path (which would demand an
    // inject this plugin cannot declare): each access goes through ctx.get.
    expect(remote.githubConnect).toBe(suite.raw.namespace)
    expect(suite.raw.get).toHaveBeenCalledWith('remote.githubConnect')
    // $on still rides the injected gateway face.
    const listener = (): void => {}
    remote.$on('credentials/updated', listener)
    expect(suite.raw.remote.$on).toHaveBeenCalledWith('credentials/updated', listener)
  })

  it('falls back to the navigator language when the page declares none', async () => {
    const suite = fakeClientCtx()
    document.documentElement.lang = ''
    await apply(suite.ctx)
    const card = suite.registrations[0]!.component({}) as ReactElement<{ locale: string }>
    // jsdom's navigator.language is en-US.
    expect(card.props.locale).toBe('en')
  })
})
