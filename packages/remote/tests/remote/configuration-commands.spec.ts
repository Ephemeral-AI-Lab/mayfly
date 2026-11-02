/** Reference local theme argument routing must work without Host persistence. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteConfigurationMountContext } from '../../src/remote/features/configuration.ts'
import { mountRemoteConfigurationComposition } from '../../src/remote/configuration-composition.ts'
const mocks = vi.hoisted(() => ({ openTheme: vi.fn(), applyTheme: vi.fn(async () => {}), applyCustomTheme: vi.fn(async () => {}), applyLocale: vi.fn(async () => {}), openLocale: vi.fn(), dispose: vi.fn() }))
vi.mock('../../src/remote/features/configuration.ts', () => ({ createRemoteConfigurationFeatures: () => ({ preferences: mocks, dispose: mocks.dispose }) }))
vi.mock('../../src/remote/features/configuration-account.ts', () => ({ RemoteAccountNodeIO: class { dispose = mocks.dispose } }))
vi.mock('../../src/remote/features/configuration-host.ts', () => ({ RemoteConfigurationHost: class {} }))
afterEach(() => { vi.clearAllMocks() })
function fixture() {
  const client = { key: HostKey('one') } as HostClient
  const commands = new RemoteFeatureCommandRegistry()
  const base = { commands, hosts: { current: () => undefined, active: () => client, list: () => [client] } } as unknown as RemoteConfigurationMountContext
  const mounted = mountRemoteConfigurationComposition(base, { clientVersion: 'test' })
  return { client, commands, mounted, signal: new AbortController().signal }
}

describe('local theme command arguments', () => {
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
