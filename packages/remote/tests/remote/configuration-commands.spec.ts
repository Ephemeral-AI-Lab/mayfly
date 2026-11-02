/** Reference local theme argument routing must work without Host persistence. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { MayflyKeyAction } from '@ephemeral-ai/mayfly/core'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteConfigurationMountContext } from '../../src/remote/features/configuration.ts'
import { mountRemoteConfigurationComposition } from '../../src/remote/configuration-composition.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
const mocks = vi.hoisted(() => ({ create: vi.fn(), cycle: vi.fn(async () => {}), openTheme: vi.fn(), applyTheme: vi.fn(async () => {}), applyCustomTheme: vi.fn(async () => {}), applyLocale: vi.fn(async () => {}), openLocale: vi.fn(), dispose: vi.fn() }))
vi.mock('../../src/remote/features/configuration.ts', () => ({ createRemoteConfigurationFeatures: (base: unknown, adapters: unknown) => { mocks.create(base, adapters); return { preferences: mocks, models: { cycle: mocks.cycle }, dispose: mocks.dispose } } }))
vi.mock('../../src/remote/features/configuration-account.ts', () => ({ RemoteAccountNodeIO: class { dispose = mocks.dispose } }))
vi.mock('../../src/remote/features/configuration-host.ts', () => ({ RemoteConfigurationHost: class {} }))
afterEach(() => { vi.clearAllMocks() })
function fixture(onModelCatalogObserved?: (client: HostClient, catalog: ModelCatalog) => void) {
  const client = { key: HostKey('one') } as HostClient
  const commands = new RemoteFeatureCommandRegistry()
  const unregister = vi.fn()
  const register = vi.fn((_actions: readonly MayflyKeyAction[]) => unregister)
  const base = { ctx: { get: () => ({ register }) }, commands, hosts: { current: () => undefined, active: () => client, list: () => [client] } } as unknown as RemoteConfigurationMountContext
  const mounted = mountRemoteConfigurationComposition(base, { clientVersion: 'test', ...onModelCatalogObserved === undefined ? {} : { onModelCatalogObserved } })
  return { client, commands, mounted, register, unregister, signal: new AbortController().signal }
}

describe('local theme command arguments', () => {
  it('delivers observed native catalog metadata through the configuration integration callback', () => {
    const observed = vi.fn()
    const test = fixture(observed)
    const catalog = { groups: [], default: { provider: 'provider', model: 'model' }, routableProviders: [], failures: [] } as ModelCatalog
    const adapters = mocks.create.mock.calls[0]![1] as { catalogObserved: (client: HostClient, catalog: ModelCatalog) => void }
    adapters.catalogObserved(test.client, catalog)
    expect(observed).toHaveBeenCalledExactlyOnceWith(test.client, catalog)
    test.mounted.dispose()
  })
  it('routes Alt+M to model cycling and removes its exact key registration on unload', async () => {
    const test = fixture()
    const action = test.register.mock.calls[0]![0][0]!
    expect(action).toMatchObject({ id: 'mayfly.interaction.cycle-model', keys: 'alt+m', scope: 'editor' })
    action.handler!()
    expect(mocks.cycle).toHaveBeenCalledOnce()
    test.mounted.dispose()
    test.mounted.dispose()
    expect(test.unregister).toHaveBeenCalledOnce()
  })
  it('routes builtin/auto/custom path/base and preserves the reference hint', async () => {
    const test = fixture()
    await test.commands.execute('theme', '', test.signal)
    await test.commands.execute('theme', 'light', test.signal)
    await test.commands.execute('theme', 'auto', test.signal)
    await test.commands.execute('theme', 'custom /local/palette.json tide', test.signal)
    await test.commands.execute('theme', 'custom /local/other.json', test.signal)
    expect(mocks.openTheme).toHaveBeenCalledOnce()
    expect(mocks.applyTheme.mock.calls).toEqual([[test.client, 'light', test.signal], [test.client, 'auto', test.signal]])
    expect(mocks.applyCustomTheme.mock.calls).toEqual([[test.client, '/local/palette.json', 'tide', test.signal], [test.client, '/local/other.json', 'dark', test.signal]])
    expect(test.commands.list().find(command => command.name === 'theme')?.input?.hint).toBe('[<theme>|auto|custom <path> [<base theme>]]')
    test.mounted.dispose()
  })

  it('rejects malformed arguments and does not start a cancelled provider swap', async () => {
    const test = fixture()
    for (const input of ['custom', 'custom path dark extra', 'light extra']) await expect(test.commands.execute('theme', input, test.signal)).rejects.toThrow('usage: /theme [<theme>|auto|custom <path> [<base theme>]]')
    const abort = new AbortController(); abort.abort()
    await test.commands.execute('theme', 'custom /local/theme.json', abort.signal)
    expect(mocks.applyTheme).not.toHaveBeenCalled()
    expect(mocks.applyCustomTheme).not.toHaveBeenCalled()
    test.mounted.dispose()
  })
})
