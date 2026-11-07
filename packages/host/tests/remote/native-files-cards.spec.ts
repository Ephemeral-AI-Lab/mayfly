/** Native builtin filesystem presenters and durable projection metadata at the actual Host boundary. @module */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { foldConversationProjection, initialConversationState } from '../../src/conversation/projection.ts'
import { presentTool } from '../../src/remote/presentation.ts'
import { nativeFilePresenters } from './native-files-presenters.ts'
import events from '../fixtures/native-files-wave24.json' with { type: 'json' }
import transport from '../../../mayfly/tests/fixtures/native-files-transport.json' with { type: 'json' }

describe('actual native filesystem presenter transport', () => {
  it('produces the committed wire fixture from untouched native PTY events and real pinned builtin definitions', () => {
    const state = events.events.reduce((state, event) => foldConversationProjection(state, event as never), initialConversationState())
    const projection = { entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: state.turns }
    expect(projection).toEqual(transport.projection)
    const definitions = nativeFilePresenters()
    expect([...definitions.keys()]).toEqual(['read', 'write', 'edit'])
    const lookup = vi.fn((name: string, selected: Agent) => { expect(selected).toBe(agent); return definitions.get(name) })
    const agent = { ctx: { tools: { get: lookup } } } as unknown as Agent
    const presentations = Object.fromEntries(projection.entries.filter(entry => entry.kind === 'tool').map(entry => [entry.callId, presentTool(agent, {
      sessionId: SessionId('session'), callId: entry.callId, updatedSeq: entry.updatedSeq, name: entry.name, arguments: entry.arguments,
      ...entry.result === undefined ? {} : { result: { content: entry.result.content.map(block => {
        if (block === null || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string') throw new Error('The native filesystem fixture must carry unchanged text content')
        return { type: 'text' as const, text: block.text }
      }), isError: entry.result.isError, ...entry.result.meta === undefined ? {} : { meta: entry.result.meta } } },
    })]))
    expect({ session: presentations }).toEqual(transport.presentations)
    expect(lookup).toHaveBeenCalledTimes(8)
    expect(presentations.native_files_read).toMatchObject({ result: { card: 'read', totalLines: 2, lines: [{ number: 1, text: 'before parity change' }, { number: 2, text: 'unchanged line' }] } })
    expect(presentations.native_files_edit).toMatchObject({ result: { card: 'diff', diffs: [{ path: `${events.provenance.cwd}/parity-change.txt`, oldText: 'before parity change\nunchanged line', newText: 'after parity change\nunchanged line' }] } })
    expect(presentations.native_files_write).toMatchObject({ result: { card: 'diff', diffs: [{ path: `${events.provenance.cwd}/parity-deliverable.txt`, oldText: null, newText: 'Native delivered file\nExact preview 你好 🪰\n' }] } })
  })
})
