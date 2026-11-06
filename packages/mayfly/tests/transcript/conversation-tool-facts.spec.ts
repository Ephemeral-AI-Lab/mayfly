/** What the conversation mapper reads for each built-in tool: its arguments and result blocks, through the presenter views. @module @ephemeral-ai/mayfly/tests/transcript/conversation-tool-facts */
import { describe, expect, it } from 'vitest'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { conversationTranscriptModel } from '../../src/transcript/conversation-model.ts'
import type { ToolPresentationSource } from '../../src/transcript/present.ts'

interface Views { readonly call?: unknown, readonly result?: unknown }

/** One settled call through a presenter that answers with `views`. */
function modelOf(name: string, args: unknown, result: Record<string, unknown> | undefined, views: Views): TranscriptEntryModel {
  const tools: ToolPresentationSource = { get: () => ({ presentCall: () => views.call, presentResult: () => views.result }) }
  const projection = { streaming: false, entries: [{
    kind: 'tool', id: 'tool:c', seq: 1, updatedSeq: 1, turn: 1, step: 1, callId: 'c', name, arguments: JSON.stringify(args), startedAt: 0, channel: 'transcript',
    ...(result === undefined ? {} : { result: { content: [], text: '', isError: false, endedAt: 5, ...result } }),
  }] } as unknown as ConversationProjection
  return conversationTranscriptModel(projection, tools).entries[0] as TranscriptEntryModel
}

const DIFF = (diffs: readonly unknown[]) => ({ card: 'diff', title: 'x', diffs })
const CHANGE = { card: 'diff', title: 'x', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] }

describe('the facts of a call', () => {
  it('reads an image from the attachment its result answered with, and nothing from a block without one', () => {
    const attachment = { mediaType: 'image/png', width: 8, height: 6, bytes: 90 }
    const call = { card: 'generic', title: 'Read image', kind: 'read', locations: [{ path: 'a.png' }] }
    expect(modelOf('read_image', { file_path: 'a.png' }, { content: [{ type: 'text', text: 'read' }, { type: 'image', attachment }] }, { call })).toMatchObject({ reads: [{ path: 'a.png', image: attachment }] })
    expect(modelOf('read_image', { file_path: 'a.png' }, { content: [{ type: 'image', attachment: { mediaType: 'image/png' } }] }, { call })).toMatchObject({ reads: [{ path: 'a.png' }] })
    expect((modelOf('read_image', { file_path: 'a.png' }, undefined, { call }) as { reads: readonly object[] }).reads[0]).not.toHaveProperty('image')
  })

  it('reads a search\'s scope and filter from its arguments, and an empty one as none', () => {
    const call = { card: 'generic', title: 'Grep', kind: 'search' }
    expect(modelOf('grep', { pattern: 'x', path: 'src', include: '*.ts' }, undefined, { call })).toMatchObject({ searches: [{ scope: 'src', include: '*.ts' }] })
    const bare = (modelOf('grep', { pattern: 'x', path: '', include: '' }, undefined, { call }) as { searches: readonly object[] }).searches[0]
    expect(bare).not.toHaveProperty('scope')
    expect(bare).not.toHaveProperty('include')
  })

  it('reads what a command was for and where it was asked to run, alone and in a group', () => {
    const call = { card: 'terminal', title: 'pnpm lint', description: 'Lint', cwd: 'src' }
    expect(modelOf('bash', { command: 'pnpm lint' }, undefined, { call })).toMatchObject({ terminal: { description: 'Lint', cwd: 'src' } })
    const tools: ToolPresentationSource = { get: () => ({ presentCall: () => call }) }
    const tool = (id: string, seq: number) => ({ kind: 'tool', id, seq, updatedSeq: seq, turn: 1, step: 1, callId: id, name: 'bash', arguments: '{"command":"pnpm lint"}', startedAt: 0, channel: 'transcript' })
    const group = conversationTranscriptModel({ streaming: false, entries: [tool('a', 1), tool('b', 2)] } as unknown as ConversationProjection, tools).entries[0]
    expect(group).toMatchObject({ commands: [{ description: 'Lint', cwd: 'src' }, {}] })
    const plain = { card: 'terminal', title: 'pnpm lint' }
    const quiet = modelOf('bash', { command: 'pnpm lint' }, undefined, { call: plain }) as { terminal: object }
    expect(quiet.terminal).not.toHaveProperty('cwd')
    expect(quiet.terminal).not.toHaveProperty('description')
    const silent: ToolPresentationSource = { get: () => ({ presentCall: () => plain }) }
    const member = (conversationTranscriptModel({ streaming: false, entries: [tool('a', 1), tool('b', 2)] } as unknown as ConversationProjection, silent).entries[0] as { commands: readonly object[] }).commands[0]
    expect(member).not.toHaveProperty('cwd')
    expect(member).not.toHaveProperty('description')
  })

  it('carries what a call outside a terminal card executes, only when the presenter says so', () => {
    expect(modelOf('bash', { command: 'pnpm dev' }, undefined, { call: { card: 'generic', title: 'pnpm dev', kind: 'execute', rawInput: 'pnpm dev', content: [{ type: 'text', text: 'Start it' }] } })).toMatchObject({ execute: { input: 'pnpm dev', note: 'Start it' } })
    const bare = modelOf('bash', { command: 'pnpm dev' }, undefined, { call: { card: 'generic', title: 'pnpm dev', kind: 'execute', rawInput: 'pnpm dev', content: [{ type: 'image' }] } }) as { execute: object }
    expect(bare.execute).toEqual({ input: 'pnpm dev' })
    expect(modelOf('skill', { name: 'x' }, undefined, { call: { card: 'generic', title: 'x', kind: 'read', rawInput: 'x' } })).not.toHaveProperty('execute')
    expect(modelOf('x', {}, undefined, { call: { card: 'generic', title: 'x', kind: 'execute', rawInput: { not: 'text' } } })).not.toHaveProperty('execute')
    expect(modelOf('x', {}, undefined, {})).not.toHaveProperty('execute')
  })

  it('names a change by the path the model gave, and by the applied one when it gave none', () => {
    expect(modelOf('edit', { file_path: 'a.ts' }, {}, { result: CHANGE })).toMatchObject({ change: { path: 'a.ts' } })
    expect(modelOf('edit', { file_path: '' }, {}, { result: CHANGE })).toMatchObject({ change: { path: '/w/a.ts' } })
    expect(modelOf('edit', {}, {}, { result: CHANGE })).toMatchObject({ change: { path: '/w/a.ts' } })
  })

  it('tells a new file from an overwrite', () => {
    const created = modelOf('write', { file_path: 'a', content: 'x\n' }, { meta: { operation: 'create' } }, { call: DIFF([{ path: 'a', oldText: null, newText: 'x\n' }]), result: DIFF([{ path: 'a', oldText: null, newText: 'x\n' }]) })
    expect(created).toMatchObject({ change: { write: { created: true, lines: 1 } } })
    const updated = modelOf('write', { file_path: 'a', content: 'y\n' }, { meta: { operation: 'update' } }, { call: DIFF([{ path: 'a', oldText: null, newText: 'y\n' }]), result: DIFF([{ path: 'a', oldText: 'x', newText: 'y' }]) })
    expect(updated).toMatchObject({ change: { write: { created: false } } })
  })
})

describe('the change of a patch', () => {
  const PATCH = '*** Begin Patch\n*** Add File: src/a.ts\n+x\n+y\n*** Delete File: src/old.ts\n*** Delete File: src/unknown.ts\n*** Update File: src/m.ts\n*** Move to: src/n.ts\n@@\n-p\n+q\n*** End Patch'
  const APPLIED = DIFF([{ path: '/w/src/old.ts', oldText: 'one\ntwo\n', newText: '' }, { path: '/w/src/x.ts', oldText: null, newText: 'z' }])

  it('has every file the patch names, the deleted ones sized by what was applied, and the counts over all', () => {
    const entry = modelOf('apply_patch', { input: PATCH }, {}, { result: APPLIED })
    expect(entry).toMatchObject({ change: { path: 'src/a.ts', added: 3, removed: 3, hiddenLines: 0, files: [
      { kind: 'A', path: 'src/a.ts', added: 2 },
      { kind: 'D', path: 'src/old.ts', removed: 2, hunks: [{ before: 'one\ntwo\n', after: '' }] },
      { kind: 'D', path: 'src/unknown.ts', removed: 0, hunks: [] },
      { kind: 'R', path: 'src/n.ts', from: 'src/m.ts', added: 1, removed: 1 },
    ] } })
  })

  it('reads a patch whose result has no diff card, and has no change without a file', () => {
    expect(modelOf('apply_patch', { input: '*** Add File: a\n+x' }, {}, {})).toMatchObject({ change: { files: [{ kind: 'A', path: 'a' }] } })
    expect(modelOf('apply_patch', { input: '*** Delete File: a' }, {}, { result: DIFF([{ path: 'a', oldText: 'x', newText: '' }]) })).toMatchObject({ change: { removed: 1 } })
    expect(modelOf('apply_patch', { input: 'nothing' }, {}, {})).not.toHaveProperty('change')
    expect(modelOf('apply_patch', {}, {}, {})).not.toHaveProperty('change')
  })

  it('reads a stopped patch as failed, with no change to claim', () => {
    const stopped = modelOf('apply_patch', { input: PATCH }, { meta: { stopped: true }, text: 'Patch stopped after 1 of 4 operations.' }, { result: APPLIED })
    expect(stopped).toMatchObject({ result: { isError: true, text: 'Patch stopped after 1 of 4 operations.' } })
    expect(stopped).not.toHaveProperty('change')
    expect(modelOf('apply_patch', { input: PATCH }, { meta: { stopped: false } }, { result: APPLIED })).toMatchObject({ result: { isError: false } })
    // The flag means this only for a patch.
    expect(modelOf('edit', { file_path: 'a' }, { meta: { stopped: true } }, { result: CHANGE })).toMatchObject({ result: { isError: false } })
  })
})
