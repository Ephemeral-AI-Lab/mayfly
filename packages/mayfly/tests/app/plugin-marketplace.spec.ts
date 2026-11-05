import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketEntry } from '../../src/plugin-marketplace.ts'
import { DEFAULT_SETTINGS } from '../../src/settings.ts'
import type { BundleInfo, ManagementError, ChangeResult } from '../../src/client/remote-face.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { mountRemoteMarketplace } from '../../src/app/operations/plugin-marketplace.ts'
import type { RemoteOperationsContext } from '../../src/app/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/app/panels/browser.ts'
import type { RemoteFeatureCommandDefinition } from '../../src/app/features/commands.ts'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })

const mocks = vi.hoisted(() => ({ open: vi.fn(), catalog: vi.fn() }))
vi.mock('../../src/app/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
vi.mock('../../src/plugin-marketplace.ts', async importOriginal => ({
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
    listBundles: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: options.bundles ?? [] })),
    installBundle: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: { application: 'restart-required' } })),
    removeBundle: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: { application: 'restart-required' } })),
    setBundleEnabled: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: { application: 'restart-required' } })),
  }
  const generation = { generation: 1 }
  const connections = new Set<() => void>()
  const client = {
    key: HostKey('host-a'), remote: { pluginManager: manager },
    state: { getSnapshot: () => generation, subscribe: (fn: () => void) => { connections.add(fn); return () => { connections.delete(fn) } } },
  } as unknown as HostClient
  const ref = { host: client.key, sessionId: SessionId('session-a') }
  const selected = { ref, client, binding: {} }
  const hosts = {
    current: vi.fn(() => options.sessionless ? undefined : selected),
    list: vi.fn(() => options.attached === false ? [] : [client]),
    active: vi.fn((): HostClient | undefined => undefined),
    subscribe: (listener: () => void) => { topology.add(listener); return () => topology.delete(listener) },
  }
  const localeListeners = new Set<(snapshot: unknown) => void>()
  const locale = {
    snapshot: { locale: 'en' }, register: vi.fn(), subscribe: vi.fn((fn: () => void) => { localeListeners.add(fn); return () => { localeListeners.delete(fn) } }),
    translate: (_namespace: string, key: string, values?: Record<string, string | number>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? name)),
  }
  const screen = { columns: 120, rows: 40 }
  const settings = { ...DEFAULT_SETTINGS }
  const services: Record<string, unknown> = {
    mayflyLocale: locale, mayflyScreen: screen, mayflyOverlays: {},
    mayflyStatus: { register: vi.fn(() => status) },
    mayflyUiInteraction: { createNotificationOwner: vi.fn(() => notify) },
    mayflyInteractionState: { settingsSource: () => settings },
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
  cleanup.push(dispose)
  const execute = (input: string, signal = new AbortController().signal) => commands[0]!.execute(input, signal)
  const change = () => { for (const listener of topology) listener() }
  return { execute, commands, dispose, manager, notify, notice, status, hosts, change, client, screen, settings, unregister, services, generation, localeListeners, reconnect: () => { generation.generation += 1; for (const fn of connections) fn() } }
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

function eventContext(signal = new AbortController().signal): MayflyUiEventContext {
  return { signal, report: vi.fn() } as unknown as MayflyUiEventContext
}

beforeEach(() => {
  mocks.open.mockReset()
  mocks.open.mockImplementation((_base, options: RemoteBrowserOptions) => { const handle = { closed: false, refresh: vi.fn(), close: vi.fn(() => { if (handle.closed) return; handle.closed = true; options.onClosed?.() }) }; return handle })
  mocks.catalog.mockReset()
  mocks.catalog.mockResolvedValue({ status: 'fresh', index: { schemaVersion: 1, entries: [entry] } })
})

describe('Remote rc.2 plugin marketplace', () => {
  it('reads the live Host-derived marketplace preference and falls back to the official index', async () => {
    const test = fixture({ sessionless: true })
    test.settings.marketIndexUrl = 'https://plugins.example/first.json'
    await test.execute('refresh')
    expect(mocks.catalog).toHaveBeenLastCalledWith('https://plugins.example/first.json', true)
    expect(test.notice.set).toHaveBeenLastCalledWith('refreshed 1 entries', 'info')
    test.settings.marketIndexUrl = 'https://plugins.example/second.json'
    await test.execute('refresh')
    expect(mocks.catalog).toHaveBeenLastCalledWith('https://plugins.example/second.json', true)
    test.settings.marketIndexUrl = ''
    await test.execute('refresh')
    expect(mocks.catalog).toHaveBeenLastCalledWith('https://raw.githubusercontent.com/Ephemeral-AI-Lab/dsh-plugins/main/dist/index.json', true)
  })

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

  it('protects product release bundles independently of native removable flags and routes direct mutations to /update', async () => {
    for (const removable of [false, true]) {
      for (const name of ['@ephemeral-ai/mayfly-host', '@ephemeral-ai/mayfly', '@ephemeral-ai/mayfly-ui', '@ephemeral-ai/mayfly-remote', '@ephemeral-ai/mayfly-cli']) {
        const test = fixture({ bundles: [bundle({ name, removable })] })
        for (const verb of ['install', 'uninstall']) {
          await test.execute(`${verb} ${name}`)
          expect(test.notice.set).toHaveBeenLastCalledWith('Manage Mayfly packages with /update', 'error')
        }
        expect(test.manager.installBundle).not.toHaveBeenCalled()
        expect(test.manager.removeBundle).not.toHaveBeenCalled()
        test.dispose()
      }
    }
  })

  it('hides product catalog and native rows while retaining third-party unlisted plugin management', async () => {
    const product = { ...entry, id: 'product', install: { rows: [{ name: '@ephemeral-ai/mayfly-host', npm: { spec: '@ephemeral-ai/mayfly-host@2.0.0' } }] } }
    mocks.catalog.mockResolvedValue(catalog([product]))
    const test = fixture({ bundles: [bundle({ name: '@ephemeral-ai/mayfly-host', removable: true }), bundle({ name: '@scope/extra' })] })
    for (const verb of ['install', 'uninstall']) {
      await test.execute(`${verb} product`)
      expect(test.notice.set).toHaveBeenLastCalledWith('Manage Mayfly packages with /update', 'error')
    }
    expect(test.manager.installBundle).not.toHaveBeenCalled()
    expect(test.manager.removeBundle).not.toHaveBeenCalled()
    await test.execute('info product')
    expect(test.notice.set).toHaveBeenLastCalledWith('Manage Mayfly packages with /update', 'error')
    await test.execute('info @ephemeral-ai/mayfly-host')
    expect(test.notice.set).toHaveBeenLastCalledWith('Manage Mayfly packages with /update', 'error')
    await test.execute('')
    await settled()
    expect(textOf(browser().view())).not.toContain('@ephemeral-ai/mayfly-host')
    expect(textOf(browser().view())).toContain('@scope/extra')
    await test.execute('uninstall @scope/extra')
    expect(test.manager.removeBundle).toHaveBeenCalledExactlyOnceWith('@scope/extra')
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
    expect(removed.notice.set).toHaveBeenCalledWith(expect.stringContaining('removed from the marketplace'), 'error')
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
    expect(textOf(browser().view())).toContain('back')
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
    expect(test.notice.set).toHaveBeenCalledWith('Attach a Host before managing plugins', 'error')
    expect(test.manager.listBundles).not.toHaveBeenCalled()
    test.dispose()
    const ready = fixture()
    await ready.execute('install alpha --source invalid')
    expect(ready.notice.set).toHaveBeenCalledWith(expect.stringContaining('usage: /plugin install'), 'error')
    await ready.execute('info missing')
    expect(ready.notice.set).toHaveBeenCalledWith('unknown plugin: missing', 'error')
    await ready.execute('unexpected')
    expect(ready.notice.set).toHaveBeenCalledWith(expect.stringContaining('usage: /plugin'), 'error')
    ready.dispose()
  })
})

const settled = () => new Promise<void>(resolve => setImmediate(resolve))
const ok = <T>(value: T) => ({ ok: true as const, value })
const perform = async (actionId: string, context = eventContext()) => await browser().action!({ kind: 'activate', actionId, controlId: 'market-actions', pagePath: [] }, context)
const choosePlugin = async (id?: string) => await browser().action!({ kind: 'selection-accept', controlId: 'plugins-browse', selectedIds: id === undefined ? [] : [id], pagePath: [] }, eventContext())
const observe = (event: Parameters<NonNullable<RemoteBrowserOptions['observe']>>[0]) => browser().observe!(event)
const catalog = (entries: readonly MarketEntry[] = [entry], extra: Record<string, unknown> = {}) => ({ status: 'fresh', index: { schemaVersion: 1, entries, ...extra } })
const nativeChange = (application: ChangeResult['application'], rest: Partial<ChangeResult> = {}) => ok({ application, ...rest })
const noticeMessages = (test: ReturnType<typeof fixture>) => test.notify.report.mock.calls.map(call => (call[2] as { message: string }).message)

describe('marketplace native refusal and mutation semantics', () => {
  it('preserves every official management refusal and build-script diagnostic without retrying writes', async () => {
    const test = fixture()
    const failures: Array<[ManagementError | undefined, string]> = [
      [undefined, 'the native plugin manager refused the change'],
      [{ code: 'incompatible-version' } as ManagementError, 'incompatible with this DSH:'],
      [{ code: 'incompatible-version', incompatible: [{ name: 'dsh', version: '9.0' }] } as ManagementError, 'incompatible with this DSH: dsh@9.0'],
      ...([
        ['management-required', 'the plugin manager protects this bundle'], ['unaddressable', 'the plugin manager cannot address this bundle'],
        ['not-removable', 'this bundle is not removable'], ['not-bundle', 'this package declares no bundle patch'],
        ['already-installed', 'this package is already installed'], ['stop-profile', 'restart Mayfly before removing this running bundle'],
        ['bundle-in-use', 'this bundle is still in use'], ['stale-approval', 'a saved build approval is out of date'],
        ['invalid-spec', 'the package spec is invalid'], ['ambiguous-install', 'the installation added more than one package'],
        ['unknown-plugin', 'the plugin is no longer installed'], ['unsupported-platform', 'this bundle does not support the Host platform'],
      ] as const).map(([code, text]) => [{ code } as ManagementError, text] as [ManagementError, string]),
      [{ code: 'operation-error' } as ManagementError, 'the package operation failed'],
      [{ code: 'operation-error', diagnostic: '' } as ManagementError, 'the package operation failed'],
    ]
    for (const [error, text] of failures) {
      const calls = test.manager.installBundle.mock.calls.length
      test.manager.installBundle.mockResolvedValueOnce(nativeChange('failed', { ...(error === undefined ? {} : { error }), pendingBuilds: [] }))
      await test.execute('install alpha')
      expect(test.manager.installBundle).toHaveBeenCalledTimes(calls + 1)
      expect(noticeMessages(test).at(-1)).toBe(`install failed: ${text}`.trimEnd())
    }
    test.manager.installBundle.mockResolvedValueOnce(nativeChange('failed', { error: { code: 'operation-error' } as ManagementError, packageResult: { output: '  native package output  ' } as NonNullable<ChangeResult['packageResult']>, pendingBuilds: ['native-build'] }))
    await test.execute('install alpha')
    expect(noticeMessages(test).at(-1)).toBe('install failed: native package output — pending builds: native-build')
    test.manager.installBundle.mockResolvedValueOnce(nativeChange('failed', { error: { code: 'operation-error', diagnostic: 'fallback diagnostic' } as ManagementError, packageResult: { output: '  ' } as NonNullable<ChangeResult['packageResult']> }))
    await test.execute('install alpha'); expect(noticeMessages(test).at(-1)).toBe('install failed: fallback diagnostic')
    test.manager.installBundle.mockResolvedValueOnce(nativeChange('failed', { error: { code: 'operation-error', diagnostic: 'start\n' + 'x'.repeat(200) + ' end' } as ManagementError }))
    await test.execute('install alpha'); expect(noticeMessages(test).at(-1)).toContain('… '); expect(noticeMessages(test).at(-1)).not.toContain('\n')
  })

  it('distinguishes applied, cancelled, overridden and restart-required installations and native enablement', async () => {
    for (const installed of [false, true]) {
      const test = fixture({ bundles: installed ? [bundle()] : [] })
      for (const application of ['applied', 'cancelled', 'overridden', 'restart-required'] as const) {
        test.manager.installBundle.mockResolvedValueOnce(nativeChange(application))
        await test.execute('install alpha')
        expect(noticeMessages(test).at(-1)).toBe(application === 'cancelled' ? 'installation cancelled' : application === 'overridden' ? 'change saved but overridden by the composition' : application === 'applied' ? installed ? 'updated' : 'installed' : installed ? 'updated; restart Mayfly and start a new session to apply' : 'installed; restart Mayfly and start a new session to apply')
      }
    }
    const offered = fixture({ bundles: [bundle({ availability: 'installation', installed: false })] })
    await offered.execute('install alpha'); expect(offered.manager.setBundleEnabled).toHaveBeenCalledWith('@scope/alpha', true)
    const current = fixture({ bundles: [bundle({ version: '2.0.0' })] })
    await current.execute('install alpha'); expect(current.manager.installBundle).not.toHaveBeenCalled(); expect(noticeMessages(current).at(-1)).toContain('already installed and up to date')
    const multiple = { ...entry, install: { rows: [...entry.install.rows, { name: '@scope/beta', npm: { spec: '@scope/beta' } }] } }
    mocks.catalog.mockResolvedValue(catalog([multiple]))
    const failed = fixture()
    failed.manager.installBundle.mockResolvedValueOnce(nativeChange('failed', { error: { code: 'not-bundle' } as ManagementError }))
    await failed.execute('install alpha'); expect(noticeMessages(failed).at(-1)).toBe('install failed: @scope/alpha: this package declares no bundle patch')
    expect(failed.manager.installBundle).toHaveBeenCalledOnce()
  })

  it('rechecks live removal ownership, handles unlisted bundles, and presents each native removal settlement', async () => {
    const missing = fixture({ bundles: [bundle()] })
    missing.manager.listBundles.mockResolvedValueOnce(ok([bundle()])).mockResolvedValueOnce(ok([]))
    await missing.execute('uninstall alpha')
    expect(missing.manager.removeBundle).not.toHaveBeenCalled(); expect(noticeMessages(missing).at(-1)).toContain('not installed')
    for (const readOnlyReason of ['management-required', 'not-removable'] as const) {
      const blocked = fixture({ bundles: [bundle()] })
      blocked.manager.listBundles.mockResolvedValueOnce(ok([bundle()])).mockResolvedValueOnce(ok([bundle({ removable: false, readOnlyReason: readOnlyReason as NonNullable<BundleInfo['readOnlyReason']> })]))
      await blocked.execute('uninstall alpha'); expect(blocked.manager.removeBundle).not.toHaveBeenCalled(); expect(noticeMessages(blocked).at(-1)).toContain(readOnlyReason === 'management-required' ? 'protects this bundle' : 'not removable')
    }
    for (const application of ['applied', 'cancelled', 'restart-required', 'failed'] as const) {
      const test = fixture({ bundles: [bundle({ name: '@scope/unlisted' })] })
      test.manager.removeBundle.mockResolvedValueOnce(nativeChange(application))
      await test.execute('uninstall @scope/unlisted')
      expect(test.manager.removeBundle).toHaveBeenCalledWith('@scope/unlisted')
      expect(noticeMessages(test).at(-1)).toBe(application === 'applied' ? 'removed' : application === 'cancelled' ? 'removal cancelled' : application === 'restart-required' ? 'removed; restart Mayfly and start a new session to apply' : 'uninstall failed: the native plugin manager refused the change')
    }
    const rejected = fixture({ bundles: [bundle()] })
    rejected.manager.removeBundle.mockRejectedValueOnce('native remove transport refused')
    await rejected.execute('uninstall alpha'); expect(noticeMessages(rejected).at(-1)).toBe('uninstall failed: native remove transport refused')
  })

  it('keeps one mutation in flight and handles unavailable sources, web-only entries, and unlisted installation', async () => {
    const test = fixture()
    const pending = Promise.withResolvers<unknown>()
    test.manager.installBundle.mockReturnValueOnce(pending.promise)
    const first = test.execute('install alpha'); await settled(); await test.execute('install alpha')
    expect(noticeMessages(test).at(-1)).toBe('a plugin operation is already running')
    pending.resolve(nativeChange('applied')); await first; expect(test.manager.installBundle).toHaveBeenCalledOnce()
    const web = { ...entry, surfaces: { web: { clientModule: true } } }
    mocks.catalog.mockResolvedValue(catalog([web]))
    const onlyWeb = fixture(); await onlyWeb.execute('install alpha'); expect(noticeMessages(onlyWeb)).toContain('web-only plugin: it contributes nothing in this terminal frontend')
    mocks.catalog.mockResolvedValue(catalog([{ ...entry, install: { rows: [{ name: '@scope/alpha', npm: { spec: '@scope/alpha' } }] } }]))
    const source = fixture(); await source.execute('install alpha --source github'); expect(noticeMessages(source).at(-1)).toBe('"Alpha plugin" has no github install source'); expect(source.manager.installBundle).not.toHaveBeenCalled()
    mocks.catalog.mockResolvedValue(catalog([{ ...entry, install: { rows: [{ name: '@scope/alpha', npm: { spec: '@scope/alpha' } }, { name: '@scope/beta', github: { repo: 'example/beta', ref: 'main' } }] } }]))
    const mixed = fixture(); await mixed.execute('install alpha'); expect(noticeMessages(mixed).at(-1)).toContain('no common install source')
    const unlisted = fixture({ bundles: [bundle({ name: '@scope/unlisted' })] }); await unlisted.execute('install @scope/unlisted'); expect(unlisted.notice.set).toHaveBeenCalledWith('this bundle is not listed in the marketplace index', 'error')
  })
})

describe('marketplace reference navigation and native catalog observations', () => {
  it('renders each index age, stale cache, offline, loading and unavailable state', async () => {
    for (const status of ['fresh', 'stale'] as const) for (const [age, expectedAge] of [[undefined, undefined], ['invalid', undefined], [new Date(Date.now() - 5 * 60_000).toISOString(), 'under an hour'], [new Date(Date.now() - 2 * 3_600_000 - 1000).toISOString(), '2h'], [new Date(Date.now() - 3 * 86_400_000 - 1000).toISOString(), '3d']] as const) {
      mocks.catalog.mockResolvedValue({ ...catalog([entry], age === undefined ? {} : { generatedAt: age }), status, message: 'offline' })
      const test = fixture(); await test.execute('info alpha'); const text = textOf(browser().view())
      expect(text).toContain(status === 'stale' ? 'offline · showing cached data' : age === undefined || age === 'invalid' ? '1 entries' : 'index updated')
      if (expectedAge !== undefined) expect(text).toContain(expectedAge)
    }
    mocks.catalog.mockResolvedValue({ status: 'offline', message: 'native market offline' })
    const offline = fixture(); await offline.execute(''); await settled(); expect(textOf(browser().view())).toContain('marketplace is offline: native market offline')
    const unavailable = fixture(); Reflect.deleteProperty(unavailable.client.remote, 'pluginManager'); await unavailable.execute(''); expect(textOf(browser().view())).toContain('plugin manager is unavailable')
    mocks.catalog.mockResolvedValue(catalog())
    const failed = fixture(); failed.manager.listBundles.mockRejectedValueOnce(new Error('native bundles unreadable')); await failed.execute(''); await settled(); expect(textOf(browser().view())).toContain('could not read installed plugins: native bundles unreadable')
    const loading = fixture(); const pending = Promise.withResolvers<unknown>(); loading.manager.listBundles.mockReturnValueOnce(pending.promise); await loading.execute(''); expect(textOf(browser().view())).toContain('loading catalog'); pending.resolve(ok([])); await settled(); expect(textOf(browser().view())).toContain('Alpha plugin')
  })

  it('shares tab, selection, source, grouping, detail and Escape semantics with the reference model', async () => {
    const test = fixture({ bundles: [bundle({ name: '@scope/unlisted' }), bundle()] })
    await test.execute(''); await settled()
    expect(browser().isCurrent()).toBe(true)
    observe({ kind: 'tab-change', controlId: 'market-tabs', tabId: 'ignored', pagePath: [] })
    for (const tabId of ['installed', 'installed', 'updates', 'browse']) observe({ kind: 'tab-change', controlId: 'market-tabs', tabId, pagePath: [] })
    for (const [controlId, itemId] of [['ignored', 'alpha'], ['plugins-installed', 'unlisted:@scope/unlisted'], ['plugins-browse', 'alpha'], ['plugins-browse', 'alpha']]) observe({ kind: 'focus-change', controlId: controlId!, itemId: itemId!, pagePath: [] })
    observe({ kind: 'focus-change', controlId: 'plugins-browse', pagePath: [] })
    observe({ kind: 'tab-change', controlId: 'market-tabs', tabId: 'installed', pagePath: [] })
    await perform('group'); await perform('group'); await perform('group')
    expect(textOf(browser().view())).toContain('group: category')
    await choosePlugin('alpha'); await choosePlugin('missing'); await choosePlugin()
    expect(await browser().action!({ kind: 'submit' } as MayflyUiActionEvent, eventContext())).toEqual({ kind: 'completed' })
    expect(await perform('ignored')).toEqual({ kind: 'completed' })
    expect(await perform('source')).toMatchObject({ kind: 'accepted', feedback: { message: 'install source: github' } })
    expect(await perform('source')).toMatchObject({ kind: 'accepted', feedback: { message: 'install source: npm' } })
    expect(browser().back?.()).toBe(false)
    expect(await browser().action!({ kind: 'dismiss', pagePath: [] }, eventContext())).toEqual({ kind: 'completed' })
    test.screen.columns = 60
    expect(await browser().action!({ kind: 'dismiss', pagePath: [] }, eventContext())).toEqual({ kind: 'completed', dismiss: false })
    expect(await browser().action!({ kind: 'dismiss', pagePath: [] }, eventContext())).toEqual({ kind: 'completed' })
    observe({ kind: 'focus-change', controlId: 'plugins-installed', itemId: 'unlisted:@scope/unlisted', pagePath: [] })
    expect(await perform('source')).toEqual({ kind: 'completed' })
    expect(await perform('install')).toMatchObject({ kind: 'failed', message: 'this bundle is not listed in the marketplace index' })
    const empty = fixture({ bundles: [] }); mocks.catalog.mockResolvedValue(catalog([])); await empty.execute(''); await settled()
    expect(textOf(browser().view())).toContain('No plugin selected')
    for (const action of ['install', 'source', 'group']) expect(await perform(action)).toMatchObject({ kind: action === 'group' ? 'accepted' : 'completed' })
  })

  it('refreshes from both command and acknowledged UI actions and reports native catalog errors', async () => {
    const test = fixture(); await test.execute('refresh'); expect(test.notice.set).toHaveBeenCalledWith('refreshed 1 entries', 'info')
    await test.execute(''); await settled()
    expect(await perform('refresh')).toMatchObject({ kind: 'accepted', feedback: { message: 'refreshed 1 entries' } })
    mocks.catalog.mockResolvedValue({ status: 'offline', message: 'catalog unreachable' })
    expect(await perform('refresh')).toMatchObject({ kind: 'failed', message: 'refresh failed: catalog unreachable' })
    await test.execute('refresh'); expect(test.notice.set).toHaveBeenLastCalledWith('refresh failed: catalog unreachable', 'error')
    mocks.catalog.mockResolvedValue(catalog()); test.manager.listBundles.mockRejectedValueOnce('native roster refused')
    expect(await perform('refresh')).toMatchObject({ kind: 'failed', message: 'refresh failed: native roster refused' })
    test.manager.listBundles.mockRejectedValueOnce('native roster refused')
    await test.execute('refresh'); expect(test.notice.set).toHaveBeenLastCalledWith('refresh failed: native roster refused', 'error')
    const unavailable = fixture(); Reflect.deleteProperty(unavailable.client.remote, 'pluginManager')
    for (const input of ['refresh', 'info alpha', 'install alpha']) { await unavailable.execute(input); expect(unavailable.notice.set).toHaveBeenLastCalledWith('plugin manager is unavailable: the native plugin service is not mounted', 'error') }
    await unavailable.execute(''); expect(await perform('refresh')).toMatchObject({ kind: 'failed', message: 'plugin manager is unavailable: the native plugin service is not mounted' })
  })

  it('updates every admitted row once, halts on failure, and retains native restart boundaries', async () => {
    const second = { ...entry, id: 'beta', displayName: 'Beta plugin', install: { rows: [{ name: '@scope/beta', npm: { spec: '@scope/beta@2' } }] }, npm: { '@scope/beta': { latestVersion: '2.0.0' } } }
    mocks.catalog.mockResolvedValue(catalog([entry, second]))
    const test = fixture({ bundles: [bundle(), bundle({ name: '@scope/beta' })] })
    await test.execute('updates'); await settled(); expect(await perform('update-all')).toMatchObject({ kind: 'accepted', feedback: { message: 'updated 2 plugins; restart Mayfly and start a new session to apply' } })
    expect(test.manager.installBundle).toHaveBeenCalledTimes(2); expect(textOf(browser().view())).toContain('2 changes apply')
    for (const listener of test.localeListeners) listener({ locale: 'en', revision: 2 })
    expect(test.status.set).toHaveBeenCalledTimes(3)
    test.manager.installBundle.mockResolvedValueOnce(nativeChange('failed'))
    expect(await perform('update-all')).toMatchObject({ kind: 'failed', message: expect.stringContaining('update all stopped at "Alpha plugin"') })
    test.manager.installBundle.mockRejectedValueOnce(new Error('update refused'))
    expect(await perform('update')).toMatchObject({ kind: 'failed', message: 'update failed: update refused' })
    const current = fixture({ bundles: [bundle({ version: '2.0.0' })] }); mocks.catalog.mockResolvedValue(catalog()); await current.execute('updates'); await settled()
    expect(await perform('update-all')).toMatchObject({ kind: 'accepted', feedback: { message: 'no plugin updates to apply' } })
  })

  it('validates every command route and honors native state and install blocks', async () => {
    const test = fixture()
    for (const input of ['install', 'uninstall', 'install alpha --source', 'info']) { await test.execute(input); expect(test.notice.set).toHaveBeenLastCalledWith(expect.stringContaining('usage: /plugin'), 'error') }
    for (const input of ['install missing', 'uninstall missing']) { await test.execute(input); expect(test.notice.set).toHaveBeenLastCalledWith('unknown plugin: missing', 'error') }
    await test.execute('uninstall alpha'); expect(test.notice.set).toHaveBeenLastCalledWith('"Alpha plugin" is not installed in this profile', 'error')
    await test.execute('list'); await settled(); expect(textOf(browser().view())).toContain('Installed')
    Reflect.deleteProperty(test.services, 'mayflyOverlays')
    for (const input of ['', 'info alpha']) { await test.execute(input); expect(test.notice.set).toHaveBeenLastCalledWith('plugin browser is unavailable: the Mayfly UI registry is not mounted', 'error') }
    mocks.catalog.mockResolvedValue(catalog([{ ...entry, status: 'removed' }]))
    const removed = fixture({ bundles: [bundle()] }); await removed.execute('info alpha'); expect(await perform('install')).toMatchObject({ kind: 'failed', message: expect.stringContaining('removed from the marketplace') })
    const available = fixture(); mocks.catalog.mockResolvedValue(catalog()); await available.execute(''); await settled(); expect(await perform('remove')).toMatchObject({ kind: 'failed', message: '"Alpha plugin" is not installed in this profile' })
  })
})

describe('marketplace exact Host ownership and late native results', () => {
  it('retires every command read/write continuation and never sends a second package or stale restart notification', async () => {
    const multiple = { ...entry, install: { rows: [...entry.install.rows, { name: '@scope/beta', npm: { spec: '@scope/beta' } }] } }
    for (const stage of ['catalog', 'initial', 'recheck', 'write', 'refresh', 'failed-refresh'] as const) for (const retire of ['cancel', 'reconnect', 'unload', 'switch'] as const) for (const reject of [false, true]) {
      mocks.catalog.mockResolvedValue(catalog([multiple]))
      const test = fixture()
      const pending = Promise.withResolvers<unknown>()
      if (stage === 'catalog') mocks.catalog.mockReturnValueOnce(pending.promise)
      else if (stage === 'initial') test.manager.listBundles.mockReturnValueOnce(pending.promise)
      else if (stage === 'recheck') test.manager.listBundles.mockResolvedValueOnce(ok([])).mockReturnValueOnce(pending.promise)
      else if (stage === 'write') test.manager.installBundle.mockReturnValueOnce(pending.promise)
      else {
        test.manager.listBundles.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([])).mockReturnValueOnce(pending.promise)
        test.manager.installBundle.mockResolvedValue(nativeChange(stage === 'failed-refresh' ? 'failed' : 'restart-required'))
      }
      const abort = new AbortController()
      const operation = test.execute('install alpha', abort.signal)
      await settled()
      if (retire === 'cancel') abort.abort()
      else if (retire === 'reconnect') test.reconnect()
      else if (retire === 'unload') test.dispose()
      else test.hosts.current.mockReturnValue({ client: { ...test.client, key: HostKey('new-host') } as HostClient, ref: { host: HostKey('new-host'), sessionId: SessionId('session-a') }, binding: {} })
      if (reject && stage !== 'catalog') pending.reject('retired native failure')
      else pending.resolve(stage === 'catalog' ? catalog([multiple]) : stage === 'write' ? nativeChange('restart-required') : ok([]))
      await operation
      expect(test.manager.installBundle.mock.calls.length).toBeLessThanOrEqual(stage === 'refresh' ? 2 : stage === 'failed-refresh' || stage === 'write' ? 1 : 0)
      expect(noticeMessages(test).some(message => message.includes('restart Mayfly') || message.includes('retired native failure'))).toBe(false)
      expect(test.status.set).not.toHaveBeenCalled()
      expect(test.notice.set).not.toHaveBeenCalled()
      if (stage === 'catalog') expect(test.manager.listBundles).not.toHaveBeenCalled()
    }
  })

  it('stops pending UI operations and update-all at the exact cancelled action or closed panel', async () => {
    for (const action of ['install', 'remove', 'update-all', 'refresh'] as const) for (const retire of ['cancel', 'close', 'reconnect', 'unload'] as const) for (const reject of [false, true]) {
      mocks.catalog.mockResolvedValue(catalog())
      const test = fixture({ bundles: [bundle()] })
      await test.execute('info alpha')
      const panel = browser()
      const pending = Promise.withResolvers<unknown>()
      if (action === 'refresh') test.manager.listBundles.mockReturnValueOnce(pending.promise)
      else if (action === 'remove') test.manager.removeBundle.mockReturnValueOnce(pending.promise)
      else test.manager.installBundle.mockReturnValueOnce(pending.promise)
      const abort = new AbortController()
      const context = eventContext(abort.signal)
      const operation = panel.action!({ kind: 'activate', actionId: action, controlId: 'market-actions', pagePath: [] }, context)
      await settled()
      if (retire === 'cancel') abort.abort()
      else if (retire === 'close') (mocks.open.mock.results.at(-1)!.value as { close(): void }).close()
      else if (retire === 'reconnect') test.reconnect()
      else test.dispose()
      if (reject) pending.reject('retired native action failure')
      else pending.resolve(action === 'refresh' ? ok([]) : nativeChange('restart-required'))
      expect(await operation).toEqual({ kind: 'cancelled' })
      expect(context.report).not.toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }))
      expect(test.status.set).not.toHaveBeenCalled()
      expect(panel.isCurrent()).toBe(retire === 'cancel')
    }
  })

  it('retains newer whole catalog/bundle snapshots and discards old successes and failures', async () => {
    for (const stage of ['catalog', 'bundles'] as const) for (const reject of [false, true]) {
      mocks.catalog.mockResolvedValue(catalog())
      const test = fixture()
      const pending = Promise.withResolvers<unknown>()
      if (stage === 'catalog') mocks.catalog.mockReturnValueOnce(pending.promise)
      else test.manager.listBundles.mockReturnValueOnce(pending.promise)
      await test.execute(''); await settled()
      mocks.catalog.mockResolvedValue(catalog([{ ...entry, displayName: 'NEW WHOLE CATALOG' }]))
      test.manager.listBundles.mockResolvedValue(ok([bundle({ version: '2.0.0' })]))
      expect(await perform('refresh')).toMatchObject({ kind: 'accepted' })
      if (reject && stage === 'bundles') pending.reject('OLD BUNDLE ERROR')
      else pending.resolve(stage === 'catalog' ? catalog([{ ...entry, displayName: 'OLD WHOLE CATALOG' }]) : ok([bundle({ version: '0.1.0' })]))
      await settled()
      expect(textOf(browser().view())).toContain('NEW WHOLE CATALOG')
      expect(textOf(browser().view())).not.toContain('OLD WHOLE CATALOG')
      expect(textOf(browser().view())).not.toContain('OLD BUNDLE ERROR')
      expect(textOf(browser().view())).not.toContain('0.1.0')
    }
  })

  it('uses active Host selection without a Session, closes replaced panels and makes disposal idempotent', async () => {
    const test = fixture({ sessionless: true })
    test.hosts.active.mockReturnValue(test.client)
    await test.execute('info @scope/alpha')
    const old = browser()
    await test.execute('list')
    expect(old.isCurrent()).toBe(false)
    expect(await old.action!({ kind: 'activate', actionId: 'install', controlId: 'market-actions', pagePath: [] }, eventContext())).toEqual({ kind: 'cancelled' })
    expect(test.manager.installBundle).not.toHaveBeenCalled()
    await test.execute('install alpha', AbortSignal.abort())
    expect(test.manager.installBundle).not.toHaveBeenCalled()
    test.dispose(); test.dispose(); expect(test.unregister).toHaveBeenCalledOnce()
  })

  it('preserves unavailable native service, removed rows and UI-only state during a late mutation', async () => {
    const test = fixture({ bundles: [bundle()] })
    await test.execute('info alpha')
    Reflect.deleteProperty(test.client.remote, 'pluginManager')
    expect(await perform('install')).toMatchObject({ kind: 'failed', message: 'plugin manager is unavailable: the native plugin service is not mounted' })
    Object.assign(test.client.remote, { pluginManager: test.manager })
    test.manager.listBundles.mockResolvedValueOnce(ok([bundle()])).mockResolvedValueOnce(ok([]))
    expect(await perform('remove')).toMatchObject({ kind: 'accepted' })
    expect(test.manager.removeBundle).toHaveBeenCalledWith('@scope/alpha')
    const unlisted = fixture({ bundles: [bundle({ name: '@scope/unlisted' })] })
    await unlisted.execute('info @scope/unlisted')
    unlisted.manager.listBundles.mockResolvedValueOnce(ok([bundle({ name: '@scope/unlisted' })])).mockResolvedValueOnce(ok([]))
    expect(await perform('remove')).toMatchObject({ kind: 'accepted' })
    expect(textOf(browser().view())).toContain('No plugin selected')
    const blank = fixture({ bundles: [] }); mocks.catalog.mockResolvedValue({ status: 'offline', message: 'offline' }); await blank.execute('info missing'); expect(blank.notice.set).toHaveBeenCalledWith('unknown plugin: missing', 'error')
    mocks.catalog.mockResolvedValue(catalog())
    const absentStatus = fixture(); Reflect.deleteProperty(absentStatus.services, 'mayflyStatus'); await absentStatus.execute('install alpha'); expect(absentStatus.status.set).not.toHaveBeenCalled()
    const noNotifications = fixture(); Reflect.deleteProperty(noNotifications.services, 'mayflyUiInteraction'); mocks.catalog.mockResolvedValue(catalog()); await noNotifications.execute('install alpha'); expect(noNotifications.notify.report).not.toHaveBeenCalled()
  })
})

describe('marketplace pending refresh ownership', () => {
  it('retires passive browse loading and both info/refresh command reads without publishing late results', async () => {
    for (const input of ['', 'info alpha', 'refresh'] as const) for (const reject of [false, true]) {
      mocks.catalog.mockResolvedValue(catalog())
      const test = fixture()
      const pending = Promise.withResolvers<unknown>()
      test.manager.listBundles.mockReturnValueOnce(pending.promise)
      const abort = new AbortController()
      const operation = test.execute(input, abort.signal)
      await settled()
      const refreshCount = input === '' ? (mocks.open.mock.results.at(-1)!.value as { refresh: ReturnType<typeof vi.fn> }).refresh.mock.calls.length : 0
      abort.abort()
      if (input === '') (mocks.open.mock.results.at(-1)!.value as { close(): void }).close()
      if (reject) pending.reject('retired passive read')
      else pending.resolve(ok([]))
      await operation; await settled()
      expect(test.notice.set).not.toHaveBeenCalled()
      expect(test.manager.installBundle).not.toHaveBeenCalled()
      if (input === '') expect((mocks.open.mock.results.at(-1)!.value as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalledTimes(refreshCount)
    }
    mocks.catalog.mockResolvedValue(catalog([{ ...entry, status: 'removed' }]))
    const removed = fixture(); await removed.execute('info alpha')
    expect(textOf(browser().view())).toContain('Removed from the market')
    const pending = Promise.withResolvers<unknown>()
    mocks.catalog.mockReturnValueOnce(pending.promise)
    const cancelled = fixture()
    const abort = new AbortController()
    const operation = cancelled.execute('info alpha', abort.signal)
    await settled(); abort.abort(); pending.resolve(catalog())
    await operation
    expect(cancelled.manager.listBundles).not.toHaveBeenCalled()
    expect(cancelled.notice.set).not.toHaveBeenCalled()
  })

  it('fences removal preflight and post-write reads and drops a UI failure reporter after cancellation', async () => {
    for (const stage of ['recheck', 'refresh', 'catch-refresh', 'failed-refresh', 'cancelled-refresh', 'overridden-refresh'] as const) for (const command of [false, true]) {
      mocks.catalog.mockResolvedValue(catalog())
      const test = fixture({ bundles: [bundle()] })
      await test.execute('info alpha')
      const pending = Promise.withResolvers<unknown>()
      if (stage === 'recheck') test.manager.listBundles.mockReturnValueOnce(pending.promise)
      else {
        test.manager.listBundles.mockResolvedValueOnce(ok([bundle()])).mockReturnValueOnce(pending.promise)
        if (stage === 'catch-refresh') test.manager.removeBundle.mockRejectedValueOnce('known transport failure')
        else if (stage === 'failed-refresh') test.manager.removeBundle.mockResolvedValueOnce(nativeChange('failed'))
        else if (stage === 'cancelled-refresh') test.manager.removeBundle.mockResolvedValueOnce(nativeChange('cancelled'))
        else if (stage === 'overridden-refresh') test.manager.installBundle.mockResolvedValueOnce(nativeChange('overridden'))
      }
      const abort = new AbortController()
      const context = eventContext(abort.signal)
      const install = stage === 'overridden-refresh'
      const operation = command ? test.execute(install ? 'install alpha' : 'uninstall alpha', abort.signal) : perform(install ? 'install' : 'remove', context)
      await settled(); abort.abort(); pending.resolve(ok([bundle()]))
      const reply = await operation
      if (!command) expect(reply).toEqual({ kind: 'cancelled' })
      expect(context.report).not.toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }))
      expect(noticeMessages(test).some(message => message.includes('restart Mayfly') || message.includes('failed'))).toBe(false)
      expect(test.status.set).not.toHaveBeenCalled()
    }
  })

  it('presents warning action feedback and closes a pending catalog load cleanly', async () => {
    mocks.catalog.mockResolvedValue(catalog())
    const test = fixture(); await test.execute('info alpha'); test.manager.installBundle.mockResolvedValueOnce(nativeChange('cancelled'))
    const context = eventContext()
    expect(await perform('install', context)).toMatchObject({ kind: 'failed', message: 'installation cancelled' })
    expect(context.report).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', message: 'installation cancelled' }))
    const loading = fixture(); const pending = Promise.withResolvers<unknown>(); mocks.catalog.mockReturnValueOnce(pending.promise)
    await loading.execute(''); await settled()
    const handle = mocks.open.mock.results.at(-1)!.value as { refresh: ReturnType<typeof vi.fn> }
    const refreshCount = handle.refresh.mock.calls.length
    loading.dispose(); pending.resolve(catalog()); await settled()
    expect(handle.refresh).toHaveBeenCalledTimes(refreshCount)
  })
})
