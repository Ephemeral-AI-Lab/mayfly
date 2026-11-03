/** Transient-only public assistant presentation without a native Session service. @module */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { transientAssistantConversation } from '../../src/conversation/transient.ts'
import { foldConversationProjection, initialConversationState } from '../../../host/src/conversation/projection.ts'

async function runtimeClosure(entry: string, visited = new Set<string>()): Promise<ReadonlySet<string>> {
  if (visited.has(entry)) return visited
  visited.add(entry)
  const parsed = ts.createSourceFile(entry, await readFile(entry, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    if (ts.isExportDeclaration(statement) && (statement.isTypeOnly || (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.every(item => item.isTypeOnly)))) continue
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly === true || (clause !== undefined && clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly))) continue
    }
    const path = statement.moduleSpecifier
    if (path !== undefined && ts.isStringLiteral(path) && path.text.startsWith('.')) await runtimeClosure(resolve(entry, '..', path.text), visited)
  }
  return visited
}

describe('transient assistant conversation', () => {
  it('keeps the durable fold unreachable from public conversation and transcript runtime graphs', async () => {
    for (const entry of ['conversation.ts', 'transcript.ts']) {
      const modules = await runtimeClosure(resolve(import.meta.dirname, '../../src', entry))
      expect([...modules].filter(path => path.endsWith('/conversation/projection.ts'))).toEqual([])
    }
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

  it('keeps an empty transient window empty', () => {
    expect(transientAssistantConversation([], { seq: 1, time: 1, turn: 1, step: 1 }).entries).toEqual([])
  })
})
