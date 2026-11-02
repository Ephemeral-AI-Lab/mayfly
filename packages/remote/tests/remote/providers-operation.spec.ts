/** Public provider routing must keep the reference configuration/model owners. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import { mountRemoteProviderOperations } from '../../src/remote/operations/providers.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

function fixture() {
  const commands = new RemoteFeatureCommandRegistry()
  const execute = vi.fn(async (_input: string, _signal: AbortSignal) => {})
  const notice = { set: vi.fn() }
  commands.register({ name: 'providers', hidden: true, description: 'configuration', execute })
  const ctx = { inject: vi.fn(), get: vi.fn(() => undefined), effect: (callback: () => unknown) => callback(), mayflyLocale: { register: vi.fn(), subscribe: vi.fn(() => () => {}) } }
  const context = { base: { ctx, commands, notice }, options: {}, presentSlot: {} } as unknown as RemoteOperationsContext
  const dispose = mountRemoteProviderOperations(context)
  const signal = new AbortController().signal
  return { commands, execute, notice, dispose, signal }
}

describe('reference provider command routing', () => {
  it('registers only the public provider command and releases it on unload', async () => {
    const test = fixture()
    expect(test.commands.list().map(command => command.name)).toEqual(['provider'])
    test.dispose()
    expect(test.commands.list()).toEqual([])
    expect(await test.commands.execute('provider', '', test.signal)).toBe(false)
  })

  it('routes bare/list/switch to the configured provider roster and native add/edit to the shared editors', async () => {
    const test = fixture()
    for (const input of ['', 'list', 'LIST', 'switch', 'add', 'ADD', 'edit deepseek', 'EDIT DeepSeek']) await test.commands.execute('provider', input, test.signal)
    expect(test.execute.mock.calls.map(call => call[0])).toEqual(['', '', '', '', 'add', 'add', 'edit deepseek', 'edit DeepSeek'])
    expect(test.execute.mock.calls.every(call => call[1] === test.signal)).toBe(true)
    test.dispose()
  })

  it('routes exact provider names and explicit switch through the shared filtered model picker', async () => {
    const test = fixture()
    for (const input of ['deepseek', 'Pretty One', 'switch p1', 'SWITCH Pretty Two']) await test.commands.execute('provider', input, test.signal)
    expect(test.execute.mock.calls.map(call => call[0])).toEqual(['switch deepseek', 'switch Pretty One', 'switch p1', 'switch Pretty Two'])
    test.dispose()
  })

  it('reports incomplete/destructive verbs and ignores cancelled or retired invocations', async () => {
    const test = fixture()
    await expect(test.commands.execute('provider', 'edit', test.signal)).rejects.toThrow('Usage: /provider edit <provider>')
    await test.commands.execute('provider', 'remove p1', test.signal)
    expect(test.notice.set).toHaveBeenCalledWith('Usage: /provider [list | edit <provider> | switch <provider> | add]')
    const controller = new AbortController(); controller.abort()
    await test.commands.execute('provider', 'add', controller.signal)
    const handler = test.commands.list()[0]!.execute
    test.dispose()
    await handler('add', test.signal)
    expect(test.execute).not.toHaveBeenCalled()
  })
})
