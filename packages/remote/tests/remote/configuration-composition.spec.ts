/** Configuration commands dispatch through the actual registry and retire every mount-owned contribution. @module */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteConfigurationMountContext } from '../../src/remote/features/configuration.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'

const feature = vi.hoisted(() => ({
  models: { open: vi.fn(async () => {}), effort: vi.fn(async () => {}), cycle: vi.fn(async () => {}) },
  providers: { open: vi.fn(async () => {}), openAdd: vi.fn(async () => {}), openEditor: vi.fn(async () => {}), openModels: vi.fn(async () => {}) },
  account: { open: vi.fn(async () => {}) }, settings: { open: vi.fn(async () => {}) }, permissions: { open: vi.fn(async () => {}) }, presets: { open: vi.fn(async () => {}) },
  preferences: { openTheme: vi.fn(), applyTheme: vi.fn(async () => {}), applyCustomTheme: vi.fn(async () => {}), openLocale: vi.fn(), applyLocale: vi.fn(async () => {}) },
  onboarding: { open: vi.fn() }, dispose: vi.fn(), ioDispose: vi.fn(), ioConstructor: vi.fn(), hostConstructor: vi.fn(), create: vi.fn(),
}))
vi.mock('../../src/remote/features/configuration.ts', () => ({ createRemoteConfigurationFeatures: vi.fn((...args: unknown[]) => { feature.create(...args); return feature }) }))
vi.mock('../../src/remote/features/configuration-account.ts', () => ({ RemoteAccountNodeIO: class {
  constructor(copy: unknown) { feature.ioConstructor(copy) }
  readonly dispose = feature.ioDispose
} }))
vi.mock('../../src/remote/features/configuration-host.ts', () => ({ RemoteConfigurationHost: class { constructor(...args: unknown[]) { feature.hostConstructor(...args) } } }))
import { mountRemoteConfigurationComposition } from '../../src/remote/configuration-composition.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop() })
beforeEach(() => { vi.clearAllMocks() })
async function fixture(keymap = true, extra = {}) {
  const ctx = new Context()
  const offKey = vi.fn(), registerKey = vi.fn((_actions: readonly { id: string, handler: () => void }[]) => offKey)
  if (keymap) ctx.provide('mayflyKeymap', { register: registerKey } as never)
  const commands = new RemoteFeatureCommandRegistry()
  const first = { key: 'first' } as HostClient, active = { key: 'active' } as HostClient, current = { key: 'current' } as HostClient
  let selected: { client: HostClient } | undefined = { client: current }
  let activeClient: HostClient | undefined = active
  let clients: readonly HostClient[] = [first]
  const base = { ctx, commands, hosts: { current: () => selected, active: () => activeClient, list: () => clients } } as unknown as RemoteConfigurationMountContext
  const handle = mountRemoteConfigurationComposition(base, { clientVersion: 'test', ...extra })
  cleanups.push(async () => { handle.dispose(); await ctx.fiber.dispose() })
  const signal = new AbortController().signal
  return { ctx, commands, base, handle, signal, first, active, current, registerKey, offKey,
    run: (name: string, input = '', currentSignal = signal) => commands.execute(name, input, currentSignal),
    currentClient: (client: HostClient | undefined) => { selected = client === undefined ? undefined : { client } },
    activeClient: (client: HostClient | undefined) => { activeClient = client }, list: (next: readonly HostClient[]) => { clients = next },
  }
}

describe('Remote configuration composition', () => {
  it('refuses missing client metadata before creating services and preserves supplied integrator hooks', async () => {
    expect(() => mountRemoteConfigurationComposition({} as never, { clientVersion: ' ' })).toThrow('clientVersion must not be empty')
    expect(feature.ioConstructor).not.toHaveBeenCalled()
    const edit = vi.fn(), copy = vi.fn(), selected = vi.fn(), observed = vi.fn()
    const f = await fixture(true, { edit, copy, onDefaultModelSelected: selected, onModelCatalogObserved: observed })
    expect(feature.ioConstructor).toHaveBeenCalledWith(copy)
    expect(feature.hostConstructor).toHaveBeenCalledWith(f.base.hosts, selected)
    expect(feature.create).toHaveBeenCalledWith(f.base, expect.objectContaining({ clientVersion: 'test', settingsEdit: edit, catalogObserved: observed }))
    const key = f.registerKey.mock.calls[0]![0]
    expect(key[0]!.id).toBe('mayfly.interaction.cycle-model'); key[0]!.handler(); expect(feature.models.cycle).toHaveBeenCalledOnce()
    f.handle.dispose(); f.handle.dispose()
    expect(f.commands.list()).toEqual([]); expect(f.offKey).toHaveBeenCalledOnce(); expect(feature.dispose).toHaveBeenCalledOnce(); expect(feature.ioDispose).toHaveBeenCalledOnce()
  })

  it('routes model and effort aliases without changing raw native selections and works without a keymap', async () => {
    const f = await fixture(false)
    await f.run('model', ' native-model '); expect(feature.models.open).toHaveBeenCalledWith(' native-model ', undefined, f.signal)
    await f.run('thinking', 'high'); expect(feature.models.effort).toHaveBeenCalledWith('high', f.signal)
    expect(f.commands.list().some(command => command.name === 'providers' || command.name === 'presets')).toBe(false)
    f.handle.dispose(); expect(feature.ioDispose).toHaveBeenCalledOnce()
  })

  it('selects the current Host, then active Host, then first attached Host for account and onboarding', async () => {
    const f = await fixture()
    await f.run('account'); expect(feature.account.open).toHaveBeenLastCalledWith(f.current, f.signal)
    f.currentClient(undefined); await f.run('account'); expect(feature.account.open).toHaveBeenLastCalledWith(f.active, f.signal)
    f.activeClient(undefined); await f.run('account'); expect(feature.account.open).toHaveBeenLastCalledWith(f.first, f.signal)
    await f.run('onboarding'); expect(feature.onboarding.open).toHaveBeenCalledWith(f.first, undefined, f.signal)
    f.list([]); feature.account.open.mockClear(); feature.onboarding.open.mockClear()
    await f.run('account'); await f.run('onboarding'); expect(feature.account.open).not.toHaveBeenCalled(); expect(feature.onboarding.open).not.toHaveBeenCalled()
    await f.run('settings'); await f.run('permissions'); await f.run('presets')
    expect(feature.settings.open).toHaveBeenCalledOnce(); expect(feature.permissions.open).toHaveBeenCalledOnce(); expect(feature.presets.open).toHaveBeenCalledOnce()
    expect(feature.settings.open).toHaveBeenCalledWith(undefined, f.signal)
    expect(feature.permissions.open).toHaveBeenCalledWith(f.signal)
    expect(feature.presets.open).toHaveBeenCalledWith(f.signal)
    for (const name of ['account', 'settings', 'permissions', 'presets', 'onboarding']) await expect(f.run(name, 'unexpected')).rejects.toThrow(`Usage: /${name}`)
  })

  it('does not dispatch any cancelled configuration picker or language write', async () => {
    const f = await fixture()
    const caller = new AbortController()
    caller.abort()
    for (const name of ['account', 'presets', 'onboarding', 'language']) await f.run(name, '', caller.signal)
    await f.run('language', 'zh', caller.signal)
    expect(feature.account.open).not.toHaveBeenCalled()
    expect(feature.presets.open).not.toHaveBeenCalled()
    expect(feature.onboarding.open).not.toHaveBeenCalled()
    expect(feature.preferences.openLocale).not.toHaveBeenCalled()
    expect(feature.preferences.applyLocale).not.toHaveBeenCalled()
  })

  it('dispatches provider management only for a current native Host and uncancelled invocation', async () => {
    const f = await fixture()
    const abort = new AbortController(); abort.abort()
    await f.run('providers', '', abort.signal); expect(feature.providers.open).not.toHaveBeenCalled()
    await f.run('providers', ' add '); expect(feature.providers.openAdd).toHaveBeenCalledWith(f.current, f.signal)
    await f.run('providers', 'edit  provider-id  '); expect(feature.providers.openEditor).toHaveBeenCalledWith(f.current, 'provider-id', f.signal)
    await f.run('providers', 'switch  provider-id  '); expect(feature.providers.openModels).toHaveBeenCalledWith(f.current, 'provider-id', f.signal)
    await f.run('providers'); expect(feature.providers.open).toHaveBeenCalledWith(f.current, f.signal)
    await expect(f.run('providers', 'unexpected')).rejects.toThrow('Usage: /provider')
    f.currentClient(undefined); f.activeClient(undefined); f.list([])
    feature.providers.open.mockClear(); await f.run('providers'); expect(feature.providers.open).not.toHaveBeenCalled()
  })

  it('dispatches exact local theme and language forms and rejects ambiguous arguments before writes', async () => {
    const f = await fixture()
    const abort = new AbortController(); abort.abort()
    await f.run('theme', 'light', abort.signal); expect(feature.preferences.applyTheme).not.toHaveBeenCalled()
    await f.run('theme'); expect(feature.preferences.openTheme).toHaveBeenCalledWith(undefined, f.signal)
    await f.run('theme', 'light'); expect(feature.preferences.applyTheme).toHaveBeenCalledWith(f.current, 'light', f.signal)
    await f.run('theme', 'custom /local/palette.json'); expect(feature.preferences.applyCustomTheme).toHaveBeenCalledWith(f.current, '/local/palette.json', 'dark', f.signal)
    await f.run('theme', 'custom /local/palette.json light'); expect(feature.preferences.applyCustomTheme).toHaveBeenCalledWith(f.current, '/local/palette.json', 'light', f.signal)
    for (const input of ['custom', 'custom /local/palette.json light extra', 'dark extra']) await expect(f.run('theme', input)).rejects.toThrow('usage: /theme')
    await f.run('language'); expect(feature.preferences.openLocale).toHaveBeenCalledWith(undefined, f.signal)
    await f.run('language', ' zh '); expect(feature.preferences.applyLocale).toHaveBeenCalledWith(f.current, 'zh', f.signal)
    f.currentClient(undefined); f.activeClient(undefined); f.list([])
    await f.run('theme', 'auto'); expect(feature.preferences.applyTheme).toHaveBeenCalledWith(undefined, 'auto', f.signal)
    await f.run('language', 'en'); expect(feature.preferences.applyLocale).toHaveBeenCalledWith(undefined, 'en', f.signal)
  })
})
