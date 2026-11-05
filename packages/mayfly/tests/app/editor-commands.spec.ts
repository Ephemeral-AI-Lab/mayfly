/** Readonly displayed views must never discover Host write commands. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { EditorCommands } from '../../src/app/editor/commands.ts'
import type { EditorFeatureSession, EditorLocalAdapter } from '../../src/app/editor/types.ts'
import { deferred } from './configuration-fixture.ts'

function fixture() {
  const list = vi.fn(async (): Promise<unknown> => ({ ok: true, value: [{ name: 'host-write', description: 'Native command' }] }))
  const local = { list: () => [{ name: 'theme', description: 'Switch the color theme' }], execute: vi.fn(async () => ({ kind: 'success' })), cwd: () => '/work', exit: () => {} } as unknown as EditorLocalAdapter
  let selected = { ref: { host: HostKey('one'), sessionId: SessionId('same') }, generation: 1, access: 'interactive', client: { remote: { commands: { list } } } } as unknown as EditorFeatureSession
  const commands = new EditorCommands({ session: () => selected, local, notice: { set: vi.fn() }, t: key => key })
  return { commands, list, local, readonly: () => { selected = { ...selected, access: 'readonly' } }, writable: () => { selected = { ...selected, access: 'interactive' } } }
}

describe('EditorCommands readonly catalog', () => {
  it('retires a writable catalog when the same Host/Session becomes readonly while preserving local commands', async () => {
    const test = fixture()
    await test.commands.refresh()
    expect(test.commands.list().map(command => command.name)).toEqual(['host-write', 'theme'])
    test.readonly()
    await test.commands.refresh()
    expect(test.list).toHaveBeenCalledOnce()
    expect(test.commands.list().map(command => command.name)).toEqual(['theme'])
    expect(test.commands.hint('host-write')).toBeUndefined()
    test.writable()
    await test.commands.refresh()
    expect(test.list).toHaveBeenCalledTimes(2)
    expect(test.commands.list().map(command => command.name)).toEqual(['host-write', 'theme'])
  })

  it('drops an in-flight writable catalog after a readonly selection commits and keeps local routing', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.list.mockReturnValueOnce(pending.promise)
    const loading = test.commands.refresh()
    test.readonly()
    await test.commands.refresh()
    pending.resolve({ ok: true, value: [{ name: 'host-write', description: 'Late command' }] })
    await loading
    expect(test.commands.list().map(command => command.name)).toEqual(['theme'])
    expect(await test.commands.execute('/theme', [], new AbortController().signal)).toMatchObject({ handled: true, accepted: true })
    expect(test.local.execute).toHaveBeenCalledOnce()
  })
})
