/** Transient-only public assistant presentation without a native Session service. @module */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { transientAssistantProjection, type TransientCursor } from '../../src/conversation/transient.ts'
import { foldAssistantStreamRecords, initialAssistantStream } from '../../../host/src/conversation/stream-accumulator.ts'
import { foldConversationProjection, initialConversationState } from '../../../host/src/conversation/projection.ts'

/** The named runtime imports every TUI source takes from Host's conversation subpath. */
async function hostConversationImports(directory: string, names = new Set<string>()): Promise<ReadonlySet<string>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) { await hostConversationImports(path, names); continue }
    if (!entry.name.endsWith('.ts')) continue
    const parsed = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (statement.moduleSpecifier.text !== '@ephemeral-ai/mayfly-host/conversation' || statement.importClause?.isTypeOnly === true) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) { names.add('*'); continue }
      for (const item of bindings.elements) if (!item.isTypeOnly) names.add((item.propertyName ?? item.name).text)
    }
  }
  return names
}

function transientAssistantConversation(stream: readonly AssistantStreamRecord[], cursor: TransientCursor) {
  return transientAssistantProjection(foldAssistantStreamRecords(initialAssistantStream(), stream), cursor)
}

describe('transient assistant conversation', () => {
  it('takes only the stream and detail helpers from the Host conversation subpath, never its durable fold', async () => {
    const names = await hostConversationImports(resolve(import.meta.dirname, '../../src'))
    expect([...names].toSorted()).toEqual(['argumentDetail', 'foldAssistantStreamRecords', 'initialAssistantStream', 'toolDetail', 'toolEntryId'])
  })

  it.each(([
    [],
    [{ type: 'chunk', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: '   ' } }],
    [{ type: 'chunk', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }],
    [{ type: 'chunk', time: 10, chunk: { type: 'text-delta', index: 0, text: 'answer' } }],
    [{ type: 'chunk', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: 'one' } }, { type: 'chunk', time: 20, chunk: { type: 'reasoning-delta', index: 0, text: 'two' } }, { type: 'chunk', time: 30, chunk: { type: 'text-delta', index: 1, text: 'answer' } }],
  ] as readonly (readonly AssistantStreamRecord[])[]).map(stream => ({ stream })))('matches the Host attempt presentation without importing its history fold: $stream', ({ stream }) => {
    const cursor = { seq: 7, time: 30, turn: 2, step: 3 }
    const state = foldConversationProjection(initialConversationState(), { type: 'assistant/attempt', ...cursor, data: { turn: 2, step: 3, stream } } as never)
    expect(transientAssistantConversation(stream, cursor)).toEqual({ entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: state.turns })
  })

  it('keeps reasoning/text ordering and never admits durable history', () => {
    const projection = transientAssistantConversation([
      { type: 'chunk', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: 'inspect' } },
      { type: 'chunk', time: 20, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
    ], { seq: 7, time: 20, turn: 2, step: 3 })
    expect(projection.entries.map(entry => ({ kind: entry.kind, text: 'text' in entry ? entry.text : undefined, turn: entry.turn }))).toEqual([
      { kind: 'thinking', text: 'inspect', turn: 2 },
      { kind: 'assistant', text: 'answer', turn: 2 },
    ])
    expect(projection.streaming).toBe(true)
    expect(projection.settledSteps).toEqual([])
  })

  it('carries a call the attempt still writes under the id its durable row will have, with what it has written so far', () => {
    const projection = transientAssistantConversation([
      { type: 'chunk', time: 10, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
      { type: 'chunk', time: 20, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', name: 'write', argumentsDelta: '{"file' } },
      { type: 'chunk', time: 30, chunk: { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '_path":"a' } },
    ] as readonly AssistantStreamRecord[], { seq: 7, time: 30, turn: 2, step: 3 })
    expect(projection.entries.at(-1)).toEqual({
      kind: 'tool', id: 'tool:c1', seq: 7, updatedSeq: 7, turn: 2, step: 3, callId: 'c1', name: 'write', arguments: '{"file_path":"a',
      startedAt: 20, channel: 'transcript', preparing: { characters: 15 },
    })
  })

  it('keeps an empty transient window empty', () => {
    expect(transientAssistantConversation([], { seq: 1, time: 1, turn: 1, step: 1 }).entries).toEqual([])
  })
})
