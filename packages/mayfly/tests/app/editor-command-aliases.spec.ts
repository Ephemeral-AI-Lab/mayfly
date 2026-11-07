/** Local alias discovery follows the same owner as actual command execution. @module tests/remote/editor-command-aliases */
import { describe, expect, it, vi } from 'vitest'
import { EditorCommands } from '../../src/app/editor/commands.ts'
import type { EditorLocalAdapter } from '../../src/app/editor/types.ts'
import { translate, wire } from './editor-feature-fixture.ts'

describe('local editor command alias ownership', () => {
  it('reserves quit aliases from native discovery and routes their original input to the local owner', async () => {
    const host = wire('one')
    host.listCommands.mockResolvedValue({ ok: true, value: [
      { name: 'q', description: 'Native q', input: { hint: '' } },
      { name: 'exit', description: 'Native exit', input: { hint: '' } },
      { name: 'compact', description: 'Compact history', input: { hint: '[instructions]' } },
    ] })
    const execute = vi.fn<EditorLocalAdapter['execute']>(() => ({ kind: 'success', exit: true }))
    const local: EditorLocalAdapter = {
      cwd: () => '/workspace', list: () => [{ name: 'quit', description: 'Exit Mayfly', aliases: ['q', 'exit'] }],
      execute, exit: vi.fn(),
    }
    const commands = new EditorCommands({ session: () => host.selected, local, notice: { set: vi.fn() }, t: translate })
    await commands.refresh()
    expect(commands.list().map(command => command.name)).toEqual(['compact', 'quit'])
    const signal = new AbortController().signal
    await expect(commands.execute('/q farewell', [], signal)).resolves.toEqual({ handled: true, exit: true, accepted: true })
    expect(execute).toHaveBeenCalledWith({ line: '/quit farewell', name: 'quit', rawInput: ' farewell', attachments: [], session: host.selected, signal })
    expect(host.executeCommand).not.toHaveBeenCalled()
  })
})
