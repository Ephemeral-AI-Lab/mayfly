import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketEntry } from '@ephemeral-ai/mayfly/plugin-marketplace'
import type { BundleInfo } from '../../src/client/remote-face.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { mountRemoteMarketplace } from '../../src/remote/operations/plugin-marketplace.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import type { RemoteFeatureCommandDefinition } from '../../src/remote/features/commands.ts'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'

const mocks = vi.hoisted(() => ({ open: vi.fn(), catalog: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
vi.mock('@ephemeral-ai/mayfly/plugin-marketplace', async importOriginal => ({
  ...await importOriginal<object>(),
  loadMarketCatalog: mocks.catalog,
}))

const entry: MarketEntry = {
  id: 'alpha', displayName: 'Alpha plugin', description: 'Reads project files.', descriptionZh: '读取项目文件。',
  source: 'community', author: { name: 'Example' }, category: 'tools', status: 'stable',
  surfaces: { server: {} },
  install: { rows: [{ name: '@scope/alpha', npm: { spec: '@scope/alpha@2.0.0' }, github: { repo: 'example/alpha', ref: 'v2' } }] },
  npm: { '@scope/alpha': { latestVersion: '2.0.0' } },
}

function bundle(overrides: Partial<BundleInfo> = {}): BundleInfo {
  return {
    name: '@scope/alpha', version: '1.0.0', enabled: true, installed: true, removable: true,
    official: false, availability: 'profile', optional: false, updatable: true,
    rows: [], overrides: [], ...overrides,
  }
}

function fixture(options: { readonly bundles?: BundleInfo[], readonly sessionless?: boolean, readonly attached?: boolean } = {}) {
  const commands: RemoteFeatureCommandDefinition[] = []
  const topology = new Set<() => void>()
  const notify = { report: vi.fn(), dispose: vi.fn() }
  const status = { set: vi.fn(), dispose: vi.fn() }
  const manager = {
    listBundles: vi.fn(async () => ({ ok: true, value: options.bundles ?? [] })),
    installBundle: vi.fn(async () => ({ ok: true, value: { application: 'restart-required' } })),
    removeBundle: vi.fn(async () => ({ ok: true, value: { application: 'restart-required' } })),
    setBundleEnabled: vi.fn(async () => ({ ok: true, value: { application: 'restart-required' } })),
  }
  const client = {
    key: HostKey('host-a'), remote: { pluginManager: manager },
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: () => () => {} },
  } as unknown as HostClient
  const ref = { host: client.key, sessionId: SessionId('session-a') }
  const selected = { ref, client, binding: {} }
  const hosts = {
    current: vi.fn(() => options.sessionless ? undefined : selected),
    list: vi.fn(() => options.attached === false ? [] : [client]),
    subscribe: (listener: () => void) => { topology.add(listener); return () => topology.delete(listener) },
  }
  const locale = {
    snapshot: { locale: 'en' }, register: vi.fn(), subscribe: vi.fn(() => () => {}),
    translate: (_namespace: string, key: string, values?: Record<string, string | number>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? name)),
  }
  const screen = { columns: 120, rows: 40 }
  const services: Record<string, unknown> = {
    mayflyLocale: locale, mayflyScreen: screen, mayflyOverlays: {},
    mayflyStatus: { register: vi.fn(() => status) },
    mayflyUiInteraction: { createNotificationOwner: vi.fn(() => notify) },
  }
  const effect = (run: () => unknown) => { const off = run(); return typeof off === 'function' ? off : () => {} }
  const ctx = {
    get: (name: string) => services[name], effect, mayflyLocale: locale,
    inject: (_deps: unknown, run: (ctx: unknown) => void) => { run({ mayflyLocale: locale, effect }); return { dispose: vi.fn() } },
  }
  const unregister = vi.fn()
  const notice = { set: vi.fn() }
  const base = {
    ctx, screen, hosts, notice,
    commands: { register: (command: RemoteFeatureCommandDefinition) => { commands.push(command); return unregister } },
    subscribeLocale: () => () => {},
  }
  const context = { base, options: {}, presentSlot: {} } as unknown as RemoteOperationsContext
  const dispose = mountRemoteMarketplace(context)
  const execute = (input: string) => commands[0]!.execute(input, new AbortController().signal)
  const change = () => { for (const listener of topology) listener() }
  return { execute, commands, dispose, manager, notify, notice, status, hosts, change, client, screen, unregister, services }
}

function browser(): RemoteBrowserOptions {
  return mocks.open.mock.calls.at(-1)![1] as RemoteBrowserOptions
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (value !== null && typeof value === 'object') return Object.values(value).map(textOf).join(' ')
  return ''
}

function eventContext(): MayflyUiEventContext {
  return { signal: new AbortController().signal, report: vi.fn() } as unknown as MayflyUiEventContext
}

beforeEach(() => {
  mocks.open.mockReset()
  mocks.open.mockImplementation(() => ({ closed: false, refresh: vi.fn(), close: vi.fn() }))
  mocks.catalog.mockReset()
  mocks.catalog.mockResolvedValue({ status: 'fresh', index: { schemaVersion: 1, entries: [entry] } })
})

describe('Remote rc.2 plugin marketplace', () => {
  it('opens the actual reference marketplace and supports sessionless browsing', async () => {
    const test = fixture({ sessionless: true })
    await test.execute('')
    expect(test.commands[0]!.name).toBe('plugin')
    await vi.waitFor(() => { expect(test.manager.listBundles).toHaveBeenCalledOnce() })
    const panel = browser()
    expect(panel.scope).toEqual({ kind: 'app', targetId: 'plugin-market' })
    expect(textOf(panel.view())).toContain('Plugin marketplace')
    expect(textOf(panel.view())).toContain('Alpha plugin')
    expect(textOf(panel.view())).toContain('Installed')
    expect(textOf(panel.view())).toContain('Updates')
    expect(textOf(panel.view())).toContain('Browse')
    expect(textOf(panel.view())).toContain('Read')
    test.dispose()
    expect(test.unregister).toHaveBeenCalledOnce()
    expect(test.notify.dispose).toHaveBeenCalledOnce()
  })

  it('uses native install results and reports the restart boundary without local package writes', async () => {
    const test = fixture()
    await test.execute('install alpha')
    expect(test.manager.installBundle).toHaveBeenCalledWith('@scope/alpha@2.0.0', { enabled: true })
    expect(test.manager.listBundles).toHaveBeenCalledTimes(3)
    expect(test.notify.report).toHaveBeenLastCalledWith(
      'plugin/alpha/install', { kind: 'app', targetId: 'plugin-market' },
      expect.objectContaining({ severity: 'success', message: 'installed; restart Mayfly and start a new session to apply' }),
      'plugin/alpha/install',
    )
    expect(test.status.set).toHaveBeenCalled()
    test.dispose()
  })

  it('uses an exact offered version and native enable for a disabled installed bundle', async () => {
    const test = fixture({ bundles: [bundle({ enabled: false, version: '2.0.0' })] })
    await test.execute('install alpha')
    expect(test.manager.setBundleEnabled).toHaveBeenCalledWith('@scope/alpha', true)
    expect(test.manager.installBundle).not.toHaveBeenCalled()
    test.dispose()

    const offered = fixture({ bundles: [bundle({ installed: false, installTarget: { spec: '@scope/alpha@2.1.0', version: '2.1.0' } })] })
    await offered.execute('install alpha')
    expect(offered.manager.installBundle).toHaveBeenCalledWith('@scope/alpha@2.1.0', { enabled: true, saveExact: true })
    offered.dispose()
  })

  it('routes GitHub sources and removal through the exact selected Host', async () => {
    const test = fixture({ bundles: [bundle()] })
    await test.execute('install alpha --source github')
    expect(test.manager.installBundle).toHaveBeenCalledWith('github:example/alpha#v2', { enabled: true })
    await test.execute('uninstall alpha')
    expect(test.manager.removeBundle).toHaveBeenCalledWith('@scope/alpha')
    test.dispose()
  })

  it('does not remove protected bundles or install removed catalog entries', async () => {
    const test = fixture({ bundles: [bundle({ removable: false })] })
    await test.execute('uninstall alpha')
    expect(test.manager.removeBundle).not.toHaveBeenCalled()
    expect(test.notify.report).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ severity: 'error' }), expect.any(String))
    test.dispose()
    mocks.catalog.mockResolvedValue({ status: 'fresh', index: { entries: [{ ...entry, status: 'removed' }] } })
    const removed = fixture()
    await removed.execute('install alpha')
    expect(removed.manager.installBundle).not.toHaveBeenCalled()
    expect(removed.notice.set).toHaveBeenCalledWith(expect.stringContaining('removed from the marketplace'))
    removed.dispose()
  })

  it('reports native refusals and never retries an unknown-outcome write', async () => {
    const test = fixture()
    test.manager.installBundle.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'connection ended' } } as never)
    await test.execute('install alpha')
    expect(test.manager.installBundle).toHaveBeenCalledOnce()
    expect(test.notify.report).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ message: 'install failed: connection ended', severity: 'error' }), expect.any(String))
    test.manager.installBundle.mockResolvedValueOnce({ ok: true, value: { application: 'failed', error: { code: 'operation-error', diagnostic: 'permission denied' } } } as never)
    await test.execute('install alpha')
    expect(test.notify.report).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ message: 'install failed: permission denied' }), expect.any(String))
    test.dispose()
  })

  it('drops late listing results on Host change and starts fresh for the next Host', async () => {
    const test = fixture()
    let finish!: (value: unknown) => void
    test.manager.listBundles.mockImplementationOnce(() => new Promise(done => { finish = done }) as never)
    const pending = test.execute('info alpha')
    await vi.waitFor(() => { expect(finish).toBeDefined() })
    const second = { ...test.client, key: HostKey('host-b'), remote: { pluginManager: { listBundles: vi.fn(async () => ({ ok: true, value: [] })) } } } as unknown as HostClient
    test.hosts.current.mockReturnValue({ client: second, ref: { host: second.key, sessionId: SessionId('session-b') }, binding: {} })
    test.hosts.list.mockReturnValue([second])
    test.change()
    finish({ ok: true, value: [bundle()] })
    await pending
    expect(mocks.open).not.toHaveBeenCalled()
    await test.execute('')
    await vi.waitFor(() => { expect(second.remote.pluginManager.listBundles).toHaveBeenCalledOnce() })
    expect(textOf(browser().view())).not.toContain('1.0.0')
    test.dispose()
  })

  it('does not send the next install unit or publish completion after detach', async () => {
    mocks.catalog.mockResolvedValue({ status: 'fresh', index: { entries: [{ ...entry, install: { rows: [...entry.install.rows, { name: '@scope/beta', npm: { spec: '@scope/beta' } }] } }] } })
    const test = fixture()
    let finish!: (value: unknown) => void
    test.manager.installBundle.mockImplementationOnce(() => new Promise(done => { finish = done }) as never)
    const pending = test.execute('install alpha')
    await vi.waitFor(() => { expect(finish).toBeDefined() })
    test.change()
    finish({ ok: true, value: { application: 'restart-required' } })
    await pending
    expect(test.manager.installBundle).toHaveBeenCalledOnce()
    expect(test.notify.report).not.toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ severity: 'success' }), expect.any(String))
    test.dispose()
  })

  it('keeps narrow details and Escape behavior from the reference component', async () => {
    const test = fixture()
    test.screen.columns = 60
    await test.execute('info alpha')
    expect(browser().back?.()).toBe(true)
    expect(browser().back?.()).toBe(false)
    await browser().action!({ kind: 'selection-accept', controlId: 'plugins-browse', selectedIds: ['alpha'], pagePath: [] } as MayflyUiActionEvent, eventContext())
    expect(browser().back?.()).toBe(true)
    await browser().action!({ kind: 'activate', actionId: 'source' } as MayflyUiActionEvent, eventContext())
    await browser().action!({ kind: 'activate', actionId: 'install' } as MayflyUiActionEvent, eventContext())
    expect(test.manager.installBundle).toHaveBeenCalledWith('github:example/alpha#v2', { enabled: true })
    test.dispose()
  })

  it('validates arguments and has an explicit unavailable state', async () => {
    const test = fixture({ attached: false, sessionless: true })
    await test.execute('')
    expect(test.notice.set).toHaveBeenCalledWith('Attach a Host before managing plugins')
    expect(test.manager.listBundles).not.toHaveBeenCalled()
    test.dispose()
    const ready = fixture()
    await ready.execute('install alpha --source invalid')
    expect(ready.notice.set).toHaveBeenCalledWith(expect.stringContaining('usage: /plugin install'))
    await ready.execute('info missing')
    expect(ready.notice.set).toHaveBeenCalledWith('unknown plugin: missing')
    await ready.execute('unexpected')
    expect(ready.notice.set).toHaveBeenCalledWith(expect.stringContaining('usage: /plugin'))
    ready.dispose()
  })
})
