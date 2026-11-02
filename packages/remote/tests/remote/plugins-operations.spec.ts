import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  MayflyFieldsNode,
  MayflyStackNode,
  MayflySurfaceNode,
  MayflyTextNode,
  MayflyUiActionEvent,
  MayflyUiEventContext,
  MayflyUiNode,
  MayflyUiObservationEvent,
} from '@ephemeral-ai/mayfly-ui'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { mountRemotePluginOperations } from '../../src/remote/operations/plugins.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('../../src/remote/panels/browser.ts', () => ({
  openRemoteBrowser: mocks.open,
}))

/** The build this frontend reports checking against: the remote package version. */
const HOST_VERSION = '0.1.4-rc.2'
/** The registry document `/update` reads; the module never asks for anything else. */
const REGISTRY_URL = 'https://registry.npmjs.org/@ephemeral-ai%2fmayfly-remote/latest'

interface CapturedCommand {
  readonly name: string
  readonly description: string
  execute(rawInput: string, signal: AbortSignal): void
}

function fixture(options: {
  readonly entries?: readonly Readonly<Record<string, unknown>>[]
  readonly result?: unknown
  readonly current?: boolean
} = {}) {
  const listPlugins = vi.fn(async (): Promise<unknown> => options.result ?? { ok: true, value: options.entries ?? [] })
  // `/update` reads the Host build through capabilities; tests re-stub it per case.
  const capabilities = vi.fn(async (): Promise<unknown> => ({ ok: true, value: { hostVersion: HOST_VERSION } }))
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: { pluginManager: { listPlugins }, mayflyHost: { capabilities } },
  } as unknown as HostClient
  const selection = { ref, client, binding: {} }
  const hosts = {
    current: vi.fn((): typeof selection | undefined => (options.current === false ? undefined : selection)),
    list: vi.fn(() => [client]),
    subscribe: vi.fn(() => () => {}),
  }
  const locale = {
    register: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    translate: vi.fn((_namespace: string, key: string) => key),
  }
  const effect = vi.fn((fn: () => unknown) => {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  })
  const ctx = {
    effect,
    inject: vi.fn((_dependencies: readonly string[], callback: (scope: { mayflyLocale: typeof locale, effect: typeof effect }) => void) => {
      callback({ mayflyLocale: locale, effect })
    }),
    get: vi.fn((name: string) => (name === 'mayflyLocale' ? locale : undefined)),
    mayflyLocale: locale,
  }
  const notice = { set: vi.fn() }
  const commands: CapturedCommand[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((command: CapturedCommand) => {
    commands.push(command)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })
  const base = {
    ctx,
    hosts,
    notice,
    commands: { register },
    t: vi.fn((key: string) => key),
    subscribeLocale: vi.fn(() => () => {}),
  }
  const context = { base, options: { localCwd: '/work/mayfly', btw: {} }, presentSlot: {} } as unknown as RemoteOperationsContext
  return { context, base, client, ref, selection, hosts, listPlugins, capabilities, notice, commands, disposers, register, locale }
}

const signal = { aborted: false } as AbortSignal

function panelChildren(node: MayflyUiNode): readonly MayflyUiNode[] {
  const surface = node as MayflySurfaceNode
  expect(surface.kind).toBe('surface')
  return (surface.child as MayflyStackNode).children.map(child => child.node)
}

/** The most recently opened browser, for a panel that was reopened by a refresh. */
function latestBrowserOf(): RemoteBrowserOptions {
  return mocks.open.mock.calls.at(-1)![1] as RemoteBrowserOptions
}

/** The value column of one panel body's `fields` node. */
function fieldValues(node: MayflyUiNode): readonly string[] {
  const fields = node as MayflyFieldsNode
  expect(fields.kind).toBe('fields')
  return fields.rows.map(row => row.value[0]!.text)
}

/** The one non-muted text of a panel body: the release verdict, or the failure line. */
function verdictOf(children: readonly MayflyUiNode[]): MayflyTextNode {
  const verdict = children.find(child => child.kind === 'text' && (child as MayflyTextNode).tone !== 'muted') as MayflyTextNode | undefined
  expect(verdict).toBeDefined()
  return verdict!
}

/** One 2xx registry answer as the module reads it: `ok`, and a JSON body. */
function registryResponse(version: unknown): { readonly ok: boolean, readonly status: number, readonly json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ version }) }
}

beforeEach(() => {
  mocks.open.mockReset()
  mocks.open.mockReturnValue({ closed: false, refresh: vi.fn(), close: vi.fn() })
})

afterEach(() => {
  // Every `/update` case installs its own registry answer.
  vi.unstubAllGlobals()
})

describe('mountRemotePluginOperations', () => {
  it('drops old Host release responses and older concurrent checks', async () => {
    const test = fixture()
    const responses: Array<(response: unknown) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { responses.push(resolve) })))
    const dispose = mountRemotePluginOperations(test.context)
    test.commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(responses).toHaveLength(1) })
    test.commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(responses).toHaveLength(2) })
    responses[1]!(registryResponse('0.3.0'))
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    responses[0]!(registryResponse('0.2.0'))
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.open).toHaveBeenCalledOnce()
    expect(fieldValues(panelChildren(latestBrowserOf().view())[0]!)).toEqual([HOST_VERSION, '0.3.0'])

    test.commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(responses).toHaveLength(3) })
    test.hosts.current.mockReturnValue({
      ...test.selection,
      ref: { host: HostKey('host-b'), sessionId: SessionId('session-b') },
      client: { ...test.client, key: HostKey('host-b') },
    })
    responses[2]!(registryResponse('0.4.0'))
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.open).toHaveBeenCalledOnce()
    dispose()
  })

  it('registers exactly /plugin and /update and unregisters both through the disposer', () => {
    const { context, register, commands, disposers, listPlugins } = fixture()
    const dispose = mountRemotePluginOperations(context)

    expect(register).toHaveBeenCalledTimes(2)
    expect(commands.map(command => command.name)).toEqual(['plugin', 'update'])
    expect(commands.map(command => command.description)).toEqual([
      'Browse, install, and remove plugins',
      'Check for a newer Mayfly release',
    ])

    commands[0]!.execute('', { aborted: true } as AbortSignal)
    expect(listPlugins).not.toHaveBeenCalled()

    dispose()
    for (const unregister of disposers) expect(unregister).toHaveBeenCalledOnce()
  })

  it('sets a notice and opens no panel when there is no current session', () => {
    const { context, commands, notice, listPlugins } = fixture({ current: false })
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)

    expect(notice.set).toHaveBeenCalledOnce()
    expect(notice.set).toHaveBeenCalledWith('No current session')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(listPlugins).not.toHaveBeenCalled()
    dispose()
  })

  it('opens the update panel offering a registry release ahead of the Host build', async () => {
    const { context, commands, ref, hosts, notice } = fixture()
    const registry = vi.fn(async (_url: string, _init: RequestInit) => registryResponse('0.2.0'))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })

    expect(registry).toHaveBeenCalledOnce()
    expect(registry.mock.calls[0]![0]).toBe(REGISTRY_URL)
    const init = registry.mock.calls[0]![1]
    expect(init.headers).toEqual({ accept: 'application/json' })
    // The module hands the request its own deadline; the stub ignores the signal.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal!.aborted).toBe(false)
    // The answer belongs in the panel, not in the transient notice.
    expect(notice.set).not.toHaveBeenCalled()

    const browser = latestBrowserOf()
    expect(browser.id).toBe('remote.operations.update')
    expect(browser.scope).toEqual({ kind: 'session', sessionId: ref.sessionId })
    expect(browser.isCurrent()).toBe(true)
    hosts.current.mockReturnValue(undefined)
    expect(browser.isCurrent()).toBe(false)
    const children = panelChildren(browser.view())
    expect(fieldValues(children[0]!)).toEqual([HOST_VERSION, '0.2.0'])
    const verdict = verdictOf(children)
    expect(verdict.tone).toBe('warning')
    expect(verdict.content).toContain('A newer release is available')
    expect((children.at(-2) as MayflyTextNode).content).toContain('Upgrades are never automatic')
    dispose()
  })

  it('keeps the newest-release verdict when the registry matches the Host build', async () => {
    const { context, commands } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse(HOST_VERSION)))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    expect(fieldValues(children[0]!)).toEqual([HOST_VERSION, HOST_VERSION])
    const verdict = verdictOf(children)
    expect(verdict.tone).toBe('success')
    expect(verdict.content).toContain('This build is the newest published release.')

    // Pre-release and build metadata are ignored by design: the final release of
    // the same dotted version reads as the same build, not as an upgrade.
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse('0.1.4')))
    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })
    const repeated = panelChildren(latestBrowserOf().view())
    expect(fieldValues(repeated[0]!)).toEqual([HOST_VERSION, '0.1.4'])
    expect(verdictOf(repeated).tone).toBe('success')
    dispose()
  })

  it('never offers an upgrade when the Host build is ahead of the registry', async () => {
    const { context, commands, capabilities } = fixture()
    const registry = vi.fn(async () => registryResponse('0.1.3'))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })

    // '0.1.3' and '0.1.4-rc.2' are unequal as strings, so a string-inequality
    // regression would offer this as an upgrade; the tone pins the comparison.
    const behind = panelChildren(latestBrowserOf().view())
    expect(fieldValues(behind[0]!)).toEqual([HOST_VERSION, '0.1.3'])
    expect(verdictOf(behind).tone).toBe('success')

    // Version parts compare numerically, so 0.1.10 is ahead of 0.1.9.
    capabilities.mockImplementationOnce(async () => ({ ok: true, value: { hostVersion: '0.1.10' } }))
    registry.mockImplementationOnce(async () => registryResponse('0.1.9'))
    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })
    const trail = panelChildren(latestBrowserOf().view())
    expect(fieldValues(trail[0]!)).toEqual(['0.1.10', '0.1.9'])
    expect(verdictOf(trail).tone).toBe('success')
    dispose()
  })

  it('reads 0.1.10 as newer than 0.1.9, which a lexicographic compare would miss', async () => {
    const { context, commands, capabilities } = fixture()
    capabilities.mockImplementationOnce(async () => ({ ok: true, value: { hostVersion: '0.1.9' } }))
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse('0.1.10')))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    expect(fieldValues(children[0]!)).toEqual(['0.1.9', '0.1.10'])
    expect(verdictOf(children).tone).toBe('warning')
    dispose()
  })

  it('paints the unreachable-registry line for a non-2xx answer without reading the body', async () => {
    const { context, commands, notice } = fixture()
    const json = vi.fn(async () => ({ version: '9.9.9' }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json })))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    const error = children[0] as MayflyTextNode
    expect(error.kind).toBe('text')
    expect(error.content).toBe('The registry could not be reached; try again later.')
    expect(error.tone).toBe('danger')
    // No facts survive a failed check, so both version fields read as unavailable.
    expect(fieldValues(children[1]!)).toEqual(['unavailable', 'unavailable'])
    expect(json).not.toHaveBeenCalled()
    expect(notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('paints the unreachable-registry line instead of rejecting when fetch fails', async () => {
    const { context, commands, notice } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    const error = children[0] as MayflyTextNode
    expect(error.content).toBe('The registry could not be reached; try again later.')
    expect(error.tone).toBe('danger')
    // The transport detail never reaches the panel.
    expect(error.content).not.toContain('ENOTFOUND')
    expect(fieldValues(children[1]!)).toEqual(['unavailable', 'unavailable'])
    expect(notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a registry document with no usable version as unreadable, not as current', async () => {
    const { context, commands } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse(42)))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    // No version in the document is not evidence that this build is current;
    // claiming "newest published release" would be a confident wrong answer.
    expect(children.filter(child => child.kind === 'text' && (child as MayflyTextNode).tone === 'danger')).toHaveLength(1)
    expect(children.some(child => child.kind === 'text' && String((child as unknown as { text?: string }).text ?? '').includes('newest'))).toBe(false)
    dispose()
  })

  it('never reopens the panel when the body read settles after teardown', async () => {
    // The fence before `response.ok` did not cover the body read: a teardown
    // that landed while json() was pending reopened a panel for a dead mount.
    const { context, commands } = fixture()
    let release!: (value: unknown) => void
    const pending = new Promise(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: () => pending,
    })))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalledOnce() })
    dispose()
    release({ version: '9.9.9' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('checks the registry even when the Host version cannot be read', async () => {
    const { context, commands, capabilities } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse('9.9.9')))
    const dispose = mountRemotePluginOperations(context)

    const failures: Array<() => Promise<unknown>> = [
      async () => { throw new Error('host offline') },
      async () => ({ ok: false, error: { code: 'unavailable', message: 'host offline' } }),
    ]
    for (const [index, failure] of failures.entries()) {
      capabilities.mockImplementationOnce(failure)
      commands[1]!.execute('', signal)
      await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(index + 1) })
      const children = panelChildren(latestBrowserOf().view())
      // No Host build means no upgrade claim, however new the registry release is.
      expect(fieldValues(children[0]!)).toEqual(['', '9.9.9'])
      expect(verdictOf(children).tone).toBe('success')
    }
    dispose()
  })

  it('drops a release check that settles after the operations are disposed', async () => {
    const { context, commands } = fixture()
    let answer: ((response: unknown) => void) | undefined
    const registry = vi.fn((_url: string, _init: RequestInit) => new Promise((resolve) => { answer = resolve }))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(registry).toHaveBeenCalledOnce() })
    dispose()
    answer!(registryResponse('9.9.9'))
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.open).not.toHaveBeenCalled()

    // A failure that lands after teardown is dropped just the same.
    const lateFailure = vi.fn(async () => { throw new Error('socket closed') })
    vi.stubGlobal('fetch', lateFailure)
    commands[1]!.execute('', signal)
    await Promise.resolve()
    expect(lateFailure).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('does not paint the update panel when the session is gone before the answer lands', async () => {
    const { context, commands, hosts } = fixture()
    let answer: ((response: unknown) => void) | undefined
    const registry = vi.fn((_url: string, _init: RequestInit) => new Promise((resolve) => { answer = resolve }))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(answer).toBeDefined() })
    hosts.current.mockReturnValue(undefined)
    answer!(registryResponse('0.2.0'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.open).not.toHaveBeenCalled()
    dispose()
  })

  it('forgets an update panel the browser reports closed and ignores observations', async () => {
    const { context, commands } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse('0.2.0')))
    const panel = { closed: false, refresh: vi.fn(), close: vi.fn() }
    mocks.open.mockReturnValue(panel)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const browser = latestBrowserOf()

    browser.observe!({ kind: 'focus-change', controlId: 'update-actions' } as unknown as MayflyUiObservationEvent)
    expect(panel.close).not.toHaveBeenCalled()

    browser.onClosed!()
    dispose()
    expect(panel.close).not.toHaveBeenCalled()
  })

  it('re-runs the release check from the update panel and answers the action as completed', async () => {
    const { context, commands } = fixture()
    const versions = ['0.2.0', '0.3.0']
    const registry = vi.fn(async (_url: string, _init: RequestInit) => registryResponse(versions.shift()))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const first = latestBrowserOf()
    expect(fieldValues(panelChildren(first.view())[0]!)).toEqual([HOST_VERSION, '0.2.0'])

    const reply = await first.action!(
      { kind: 'activate', actionId: 'update-refresh' } as MayflyUiActionEvent,
      { signal } as unknown as MayflyUiEventContext,
    )
    expect(reply).toEqual({ kind: 'completed' })
    await vi.waitFor(() => { expect(registry).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })

    // A refresh replaces the panel rather than stacking a second one.
    expect(mocks.open.mock.results[0]!.value.close).toHaveBeenCalledOnce()
    expect(fieldValues(panelChildren(latestBrowserOf().view())[0]!)).toEqual([HOST_VERSION, '0.3.0'])

    // Any other activation is still answered, and triggers no check.
    const ignored = await latestBrowserOf().action!(
      { kind: 'activate', actionId: 'update-other' } as MayflyUiActionEvent,
      { signal } as unknown as MayflyUiEventContext,
    )
    expect(ignored).toEqual({ kind: 'completed' })
    await Promise.resolve()
    expect(registry).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('pads a shorter version with zeros, so 0.2 and 0.2.0 are the same release', async () => {
    const { context, commands, capabilities } = fixture()
    const registry = vi.fn(async () => registryResponse('0.2.0'))
    vi.stubGlobal('fetch', registry)
    const dispose = mountRemotePluginOperations(context)

    capabilities.mockImplementationOnce(async () => ({ ok: true, value: { hostVersion: '0.2' } }))
    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const shorterHost = panelChildren(latestBrowserOf().view())
    expect(fieldValues(shorterHost[0]!)).toEqual(['0.2', '0.2.0'])
    expect(verdictOf(shorterHost).tone).toBe('success')

    capabilities.mockImplementationOnce(async () => ({ ok: true, value: { hostVersion: '0.2.0' } }))
    registry.mockImplementationOnce(async () => registryResponse('0.2'))
    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })
    const shorterRegistry = panelChildren(latestBrowserOf().view())
    expect(fieldValues(shorterRegistry[0]!)).toEqual(['0.2.0', '0.2'])
    expect(verdictOf(shorterRegistry).tone).toBe('success')
    dispose()
  })

  it('does not treat a version without a numeric part as an upgrade', async () => {
    const { context, commands } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => registryResponse('nightly')))
    const dispose = mountRemotePluginOperations(context)

    commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    const children = panelChildren(latestBrowserOf().view())
    // The unparsable part counts as zero against a real build, so there is no upgrade claim.
    expect(fieldValues(children[0]!)).toEqual([HOST_VERSION, 'nightly'])
    expect(verdictOf(children).tone).toBe('success')
    dispose()
  })

  it('registers a zh catalog holding every key the module translates', () => {
    const { context, locale } = fixture()
    const dispose = mountRemotePluginOperations(context)

    const [namespace, catalog] = locale.register.mock.calls.find(call => call[0] === 'remote-plugins')! as unknown as [
      string,
      { readonly en: Readonly<Record<string, string>>, readonly zh: Readonly<Record<string, string>> },
    ]
    expect(namespace).toBe('remote-plugins')
    // English messages are the keys themselves, so both tables must agree.
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog.zh).sort())
    for (const [key, message] of Object.entries(catalog.en)) expect(message).toBe(key)
    // The string this catalog was missing before the fix.
    expect(catalog.zh['No current session']).toBe('当前没有会话')

    // Derive the module's own t('...') literals and require a Chinese message
    // for each, so a new user-visible string without a translation fails here.
    const source = readFileSync(new URL('../../src/remote/operations/plugins.ts', import.meta.url), 'utf8')
    const translated = [...new Set([...source.matchAll(/\bt\('([^']*)'\)/gu)].map(match => match[1]!))]
    expect(translated).toContain('No current session')
    expect(translated.filter(key => catalog.zh[key] === undefined)).toEqual([])
    dispose()
  })
})
