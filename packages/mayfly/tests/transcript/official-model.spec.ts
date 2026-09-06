import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ConversationProjection, ConversationToolEntry } from '../../src/conversation/index.ts'
import {
  conversationTranscriptModel,
  OfficialConversationModelSource,
  type ConversationProjectionSource,
} from '../../src/transcript/official-model.ts'
import type { ToolPresentationSource } from '../../src/transcript/present.ts'

function projection(entries: ConversationProjection['entries'] = [], streaming = false): ConversationProjection {
  return { entries: entries.map(entry => ({ ...entry, updatedSeq: entry.updatedSeq ?? entry.seq })), streaming }
}

function toolSource(options: { readonly throws?: boolean } = {}): ToolPresentationSource {
  return {
    get(name: string) {
      if (options.throws) throw new Error('registry down')
      if (name !== 'read') return undefined
      return {
        presentCall: (args: unknown) => ({ card: 'generic', title: 'Reading', rawInput: args }),
        presentResult: (_args: unknown, result: { readonly isError: boolean }) => ({
          card: 'generic',
          title: result.isError ? 'Failed' : 'Read',
          content: [{ type: 'text', text: 'presented' }],
        }),
      } as never
    },
  } as Pick<ToolRuntime, 'get'>
}

function transcriptTool(overrides: Partial<ConversationToolEntry> = {}): ConversationToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    seq: 4,
    turn: 1,
    step: 0,
    callId: 'call-1',
    name: 'read',
    arguments: '{"path":"a.txt"}',
    startedAt: 100,
    channel: 'transcript',
    ...overrides,
  }
}

/** A presenter vocabulary that declares reads: `kind: 'read'` calls and read result cards from meta. */
function readSource(): ToolPresentationSource {
  return {
    get(name: string) {
      if (name !== 'read') return undefined
      return {
        presentCall: () => ({ card: 'generic', title: 'Read a.txt', kind: 'read' }),
        presentResult: (_args: unknown, result: { readonly isError: boolean; readonly meta?: unknown }) => {
          if (result.isError) return undefined
          const meta = result.meta as { readonly path: string; readonly offset: number; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number } | undefined
          if (meta === undefined) return undefined
          return { card: 'read', path: meta.path, offset: meta.offset, lines: meta.lines, totalLines: meta.totalLines }
        },
      } as never
    },
  } as Pick<ToolRuntime, 'get'>
}

/** A presenter vocabulary that declares searches: `kind: 'search'` calls and search result cards from meta. */
function searchSource(): ToolPresentationSource {
  return {
    get(name: string) {
      if (name !== 'grep' && name !== 'glob') return undefined
      return {
        presentCall: (args: unknown) => ({ card: 'generic', title: `Search ${String((args as { pattern?: string }).pattern ?? '')}`, kind: 'search' }),
        presentResult: (_args: unknown, result: { readonly isError: boolean; readonly meta?: unknown }) => {
          if (result.isError) return undefined
          const meta = result.meta as { readonly shape: 'matches' | 'paths'; readonly files?: { readonly path: string; readonly matches: { readonly lineNumber: number; readonly line: string }[] }[]; readonly paths?: readonly string[]; readonly truncated: boolean; readonly total: number } | undefined
          if (meta === undefined) return undefined
          return meta.shape === 'matches'
            ? { card: 'search', shape: 'matches', files: meta.files ?? [], truncated: meta.truncated, total: meta.total }
            : { card: 'search', shape: 'paths', paths: meta.paths ?? [], truncated: meta.truncated, total: meta.total }
        },
      } as never
    },
  } as Pick<ToolRuntime, 'get'>
}

interface SearchMeta {
  readonly shape: 'matches' | 'paths'
  readonly files?: { readonly path: string; readonly matches: { readonly lineNumber: number; readonly line: string }[] }[]
  readonly paths?: readonly string[]
  readonly truncated: boolean
  readonly total: number
}

function searchResult(meta: SearchMeta | undefined, isError = false): ConversationToolEntry['result'] {
  return {
    content: [{ type: 'text', text: isError ? 'pattern rejected' : 'raw' }],
    text: isError ? 'pattern rejected' : 'raw',
    isError,
    endedAt: 180,
    ...(meta === undefined ? {} : { meta }),
  }
}


interface ReadMeta { readonly path: string; readonly offset: number; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number }

/** A registry resolving both families at once for mixed-run fixtures. */
function combinedSource(): ToolPresentationSource {
  const read = readSource()
  const search = searchSource()
  return {
    get(name: string) {
      return read.get(name) ?? search.get(name)
    },
  } as Pick<ToolRuntime, 'get'>
}

/** The jobs reader's presenter: a `kind: 'read'` call view and no result card. */
function jobSource(): ToolPresentationSource {
  return {
    get(name: string) {
      if (name !== 'job_output') return undefined
      return { presentCall: () => ({ card: 'generic', title: 'Read output from background job 5', kind: 'read' }) } as never
    },
  } as Pick<ToolRuntime, 'get'>
}

function readResult(meta: ReadMeta | undefined, isError = false): ConversationToolEntry['result'] {
  return {
    content: [{ type: 'text', text: isError ? 'File not found: nope.txt' : 'raw' }],
    text: isError ? 'File not found: nope.txt' : 'raw',
    isError,
    endedAt: 180,
    ...(meta === undefined ? {} : { meta }),
  }
}

function sourceFixture(initial: ConversationProjection | unknown = projection(), initialSeq = 0) {
  let snapshotValue = initial
  let snapshotSeq = initialSeq
  const session = { id: 'session-1' } as unknown as Session
  let changed: ((session: Session, key: string, value: unknown, seq: number) => void) | undefined
  const off = vi.fn()
  const source: ConversationProjectionSource = {
    snapshot: vi.fn(() => ({ asOfSeq: snapshotSeq, values: { mayflyConversation: snapshotValue } })),
    onChanged: vi.fn(listener => {
      changed = listener
      return off
    }),
  }
  return {
    source,
    session,
    off,
    set(value: unknown, seq: number) {
      snapshotValue = value
      snapshotSeq = seq
    },
    emit(key: string, value: unknown, seq: number, target = session) {
      changed?.(target, key, value, seq)
    },
  }
}

describe('official conversation model mapping', () => {
  it('bounds conversion before freezing a long projection', () => {
    const entries = Array.from({ length: 203 }, (_, index) => ({
      kind: 'assistant' as const,
      id: `assistant-${String(index)}`,
      seq: index,
      turn: index,
      step: 0,
      text: `answer ${String(index)}`,
      streaming: false,
    }))
    const model = conversationTranscriptModel(projection(entries), toolSource())
    expect(model.entries).toHaveLength(203)
    expect(model.entries[0]).toMatchObject({ id: 'assistant-0' })
  })

  it('maps every semantic entry and filters tool-owned dock channels', () => {
    const model = conversationTranscriptModel(projection([
      {
        kind: 'user', id: 'user-1', seq: 1, turn: 1, text: 'hello', images: [{
          attachmentId: 'image-1', mediaType: 'image/png', bytes: 12, width: 4, height: 3,
          name: 'plot.png', originalDimensions: { width: 8, height: 6 },
        }, {
          attachmentId: 'image-2', mediaType: 'image/jpeg', bytes: 8, width: 2, height: 2,
        }],
      },
      { kind: 'assistant', id: 'assistant-1', seq: 2, turn: 1, step: 0, text: 'answer', streaming: true },
      { kind: 'thinking', id: 'thinking-1', seq: 3, turn: 1, step: 0, text: 'thought', streaming: false },
      transcriptTool({
        result: {
          content: [{ type: 'text', text: 'raw' }],
          text: 'raw',
          isError: false,
          endedAt: 180,
          meta: { path: 'a.txt' },
        },
      }),
      transcriptTool({ id: 'todo-1', callId: 'todo-1', channel: 'todo' }),
      transcriptTool({ id: 'agent-1', callId: 'agent-1', channel: 'agents' }),
      { kind: 'error', id: 'error-1', seq: 7, turn: 1, message: 'down', code: 'HTTP_404' },
      { kind: 'error', id: 'error-2', seq: 8, turn: 1, message: 'unknown' },
      { kind: 'interrupted', id: 'cut-1', seq: 9, turn: 1 },
    ], true), toolSource())

    expect(model.streaming).toBe(true)
    expect(model.entries).toHaveLength(7)
    expect(model.entries).toMatchObject([
      { kind: 'transcript-user', text: 'hello', images: [
        { name: 'plot.png', originalDimensions: { width: 8, height: 6 } },
        { attachmentId: 'image-2', mediaType: 'image/jpeg' },
      ] },
      { kind: 'transcript-assistant', text: 'answer', streaming: true },
      { kind: 'transcript-thinking', text: 'thought', streaming: false },
      {
        kind: 'transcript-tool',
        result: { text: 'raw', fullText: 'raw', isError: false, endedAt: 180 },
        presentation: { kind: 'tool', call: { kind: 'sections' }, result: { kind: 'sections' } },
      },
      { kind: 'transcript-error', message: 'down', code: 'HTTP_404' },
      { kind: 'transcript-error', message: 'unknown' },
      { kind: 'transcript-interrupted' },
    ])
    expect(Object.isFrozen(model)).toBe(true)
  })

  it('falls back safely when arguments, registry, or presenters are absent', () => {
    const pending = conversationTranscriptModel(projection([
      transcriptTool({ arguments: '{bad', name: 'missing' }),
    ]), toolSource({ throws: true }))
    expect(pending.entries[0]).toMatchObject({
      kind: 'transcript-tool',
    })
    expect((pending.entries[0] as { presentation?: unknown }).presentation).toBeUndefined()

    const failed = conversationTranscriptModel(projection([
      transcriptTool({
        result: { content: [{ type: 'text', text: 'failure' }], text: 'failure', isError: true, endedAt: 200 },
      }),
    ]), toolSource())
    expect(failed.entries[0]).toMatchObject({
      presentation: { result: { kind: 'text', content: 'failure', tone: 'danger' } },
    })

    const resultOnly = conversationTranscriptModel(projection([
      transcriptTool({
        result: { content: [{ type: 'text', text: 'done' }], text: 'done', isError: false, endedAt: 210 },
      }),
    ]), {
      get: () => ({
        presentResult: () => ({ card: 'generic', title: 'Result only' }),
      } as never),
    } as ToolPresentationSource)
    expect(resultOnly.entries[0]).toMatchObject({
      presentation: { call: { kind: 'text', content: 'read' }, result: { kind: 'sections' } },
    })
  })

  it('groups consecutive reads, transparently across thinking, into one entry per run', () => {
    const window = (path: string, offset: number, count: number, total: number): ReadMeta => ({
      path,
      offset,
      lines: Array.from({ length: count }, (_, index) => ({ number: offset + index, text: `${path} line ${String(offset + index)}` })),
      totalLines: total,
    })
    const model = conversationTranscriptModel(projection([
      { kind: 'assistant', id: 'assistant-1', seq: 1, turn: 1, step: 0, text: 'looking', streaming: false },
      transcriptTool({ id: 'r1', callId: 'c-r1', seq: 2, arguments: '{"file_path":"src/a.ts","offset":1,"limit":100}', result: readResult(window('src/a.ts', 1, 100, 342)) }),
      { kind: 'thinking', id: 'thinking-1', seq: 3, turn: 1, step: 1, text: 'considering', streaming: false },
      transcriptTool({ id: 'r2', callId: 'c-r2', seq: 4, arguments: '{"file_path":"src/a.ts","offset":101,"limit":120}', result: readResult(window('src/a.ts', 101, 120, 342)) }),
      transcriptTool({ id: 'r3', callId: 'c-r3', seq: 5, arguments: '{"file_path":"missing.txt"}', result: readResult(undefined, true) }),
    ]), readSource())

    expect(model.entries).toHaveLength(3)
    expect(model.entries[0]).toMatchObject({ kind: 'transcript-assistant', text: 'looking' })
    expect(model.entries[1]).toMatchObject({ kind: 'transcript-thinking', text: 'considering' })
    const group = model.entries[2] as { kind: string; id: string; reads: unknown[] }
    expect(group).toMatchObject({ kind: 'transcript-read-group', id: 'read-group:r1', seq: 2, turn: 1, step: 0 })
    expect(group.reads).toHaveLength(3)
    expect(Object.isFrozen(group)).toBe(true)
  })

  it('breaks runs on content, other tools, other turns, and invisible channels keep runs intact', () => {
    const reads = (): ConversationProjection['entries'] => [
      transcriptTool({ id: 'r1', callId: 'c1', seq: 1 }),
      transcriptTool({ id: 'r2', callId: 'c2', seq: 2 }),
    ]
    const kinds = conversationTranscriptModel(projection([
      transcriptTool({ id: 'r1', callId: 'c1', seq: 1 }),
      { kind: 'user', id: 'u1', seq: 2, turn: 2, text: 'more', images: [] },
      transcriptTool({ id: 'r2', callId: 'c2', seq: 3, turn: 2 }),
    ]), readSource())
    expect(kinds.entries.map(entry => entry.kind)).toEqual(['transcript-read-group', 'transcript-user', 'transcript-read-group'])

    const crossTool = conversationTranscriptModel(projection([
      transcriptTool({ id: 'r1', callId: 'c1', seq: 1 }),
      transcriptTool({ id: 'b1', callId: 'c9', seq: 2, name: 'bash', arguments: '{"command":"ls"}' }),
      transcriptTool({ id: 'r2', callId: 'c2', seq: 3 }),
    ]), readSource())
    expect(crossTool.entries.map(entry => entry.kind)).toEqual(['transcript-read-group', 'transcript-tool', 'transcript-read-group'])

    const crossTurn = conversationTranscriptModel(projection(reads().map((entry, index) => (
      index === 0 ? entry : { ...entry, turn: 2 }
    ))), readSource())
    expect(crossTurn.entries.map(entry => entry.kind)).toEqual(['transcript-read-group', 'transcript-read-group'])

    const invisible = conversationTranscriptModel(projection([
      transcriptTool({ id: 'r1', callId: 'c1', seq: 1 }),
      transcriptTool({ id: 'todo-1', callId: 't1', seq: 2, channel: 'todo' }),
      transcriptTool({ id: 'agent-1', callId: 'a1', seq: 3, channel: 'agents' }),
      transcriptTool({ id: 'r2', callId: 'c2', seq: 4 }),
    ]), readSource())
    expect(invisible.entries.map(entry => entry.kind)).toEqual(['transcript-read-group'])

    const single = conversationTranscriptModel(projection([transcriptTool({ id: 'r9', callId: 'c9', seq: 9 })]), readSource())
    expect(single.entries).toHaveLength(1)
    expect(single.entries[0]).toMatchObject({ kind: 'transcript-read-group' })

    // A presenter that never claims read keeps the plain tool card (the
    // legacy-fixture contract: no vocabulary, no grouping).
    const legacy = conversationTranscriptModel(projection(reads()), toolSource())
    expect(legacy.entries.map(entry => entry.kind)).toEqual(['transcript-tool', 'transcript-tool'])
  })

  it('derives read facts from arguments and result views, bounding previews', () => {
    const lines = Array.from({ length: 8 }, (_, index) => ({ number: 101 + index, text: `l${String(index)}` }))
    const model = conversationTranscriptModel(projection([
      transcriptTool({
        id: 'rich', callId: 'c-rich', seq: 2, arguments: '{"file_path":"big.ts","offset":101,"limit":8}',
        result: readResult({ path: 'big.ts', offset: 101, lines, totalLines: 400 }),
      }),
      transcriptTool({
        id: 'pending', callId: 'c-pending', seq: 3, arguments: '{"file_path":"next.ts","offset":5,"limit":30}',
      }),
      transcriptTool({
        id: 'metaless', callId: 'c-metaless', seq: 4, arguments: '{"file_path":"old.txt"}',
        result: { content: [{ type: 'text', text: 'ok' }], text: 'ok', isError: false, endedAt: 1 },
      }),
      transcriptTool({
        id: 'noargs', callId: 'c-noargs', seq: 5, arguments: '{bad',
        result: readResult(undefined, true),
      }),
    ]), readSource())
    const group = model.entries[0] as unknown as { reads: Array<Record<string, unknown>> }
    expect(group.reads[0]).toMatchObject({
      callId: 'c-rich', path: 'big.ts', requestedRange: { first: 101, last: 108 }, range: { first: 101, last: 108 },
      totalLines: 400, state: 'ok', previewLines: { length: 5 },
    })
    expect((group.reads[0]!['previewLines'] as Array<{ number: number }>)[0]).toMatchObject({ number: 101 })
    expect(group.reads[1]).toMatchObject({ callId: 'c-pending', path: 'next.ts', state: 'pending', requestedRange: { first: 5, last: 34 } })
    expect(group.reads[1]!['previewLines']).toBeUndefined()
    expect(group.reads[2]).toMatchObject({ callId: 'c-metaless', path: 'old.txt', state: 'ok' })
    expect(group.reads[2]!['range']).toBeUndefined()
    expect(group.reads[3]).toMatchObject({ callId: 'c-noargs', state: 'error', error: 'File not found: nope.txt' })
    expect(group.reads[3]!['path']).toBeUndefined()
  })

  it('falls back to the view path and the stock error line', () => {
    const model = conversationTranscriptModel(projection([
      transcriptTool({
        id: 'viewpath', callId: 'c-viewpath', seq: 1, arguments: '{}',
        result: readResult({ path: 'from-view.ts', offset: 2, lines: [{ number: 2, text: 'x' }], totalLines: 2 }),
      }),
      transcriptTool({
        id: 'blank', callId: 'c-blank', seq: 2, arguments: '{"file_path":"b.txt"}',
        result: { content: [{ type: 'text', text: '\n  \n' }], text: '\n  \n', isError: true, endedAt: 9 },
      }),
    ]), readSource())
    const group = model.entries[0] as unknown as { reads: Array<Record<string, unknown>> }
    expect(group.reads[0]).toMatchObject({ callId: 'c-viewpath', path: 'from-view.ts', range: { first: 2, last: 2 } })
    expect(group.reads[1]).toMatchObject({ callId: 'c-blank', state: 'error', error: 'read failed' })
  })

  it('labels read-kind calls without a file by their salient argument', () => {
    const model = conversationTranscriptModel(projection([
      transcriptTool({ id: 'j1', callId: 'c-j1', seq: 1, name: 'job_output', arguments: '{"job_id":"5","wait":true}' }),
      transcriptTool({ id: 'j2', callId: 'c-j2', seq: 2, name: 'job_output', arguments: '{"job_id":"5"}', result: { content: [{ type: 'text', text: 'chunk\n[status: running]' }], text: 'chunk\n[status: running]', isError: false, endedAt: 9 } }),
      transcriptTool({ id: 'j3', callId: 'c-j3', seq: 3, name: 'job_output', arguments: `{\"payload\":\"${'x'.repeat(70)}\"}` }),
    ]), jobSource())
    const group = model.entries[0] as unknown as { reads: Array<Record<string, unknown>> }
    expect(model.entries).toHaveLength(1)
    expect(group.reads[0]).toMatchObject({ callId: 'c-j1', label: 'job_id: 5', state: 'pending' })
    expect(group.reads[1]).toMatchObject({ callId: 'c-j2', label: 'job_id: 5', state: 'ok' })
    // No short string argument at all: the member joins the count but no row.
    expect(group.reads[2]).toMatchObject({ callId: 'c-j3', state: 'pending' })
    expect(group.reads[2]!['label']).toBeUndefined()
  })

  it('groups mixed grep and glob runs while reads keep their own family', () => {
    const matches: SearchMeta = {
      shape: 'matches',
      files: [
        { path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }, { lineNumber: 2, line: 'y' }, { lineNumber: 3, line: 'z' }, { lineNumber: 4, line: 'w' }] },
      ],
      truncated: true, total: 40,
    }
    const paths: SearchMeta = { shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 }
    const grep = (id: string, callId: string, seq: number, args: string, result: ConversationToolEntry['result']): ConversationToolEntry =>
      transcriptTool({ id, callId, seq, name: 'grep', arguments: args, result })
    const model = conversationTranscriptModel(projection([
      transcriptTool({ id: 'r0', callId: 'c-r0', seq: 1, name: 'read', arguments: '{"file_path":"a.ts"}' }),
      grep('s1', 'c-s1', 2, '{"pattern":"export"}', searchResult(matches)),
      { kind: 'thinking', id: 't1', seq: 3, turn: 1, step: 1, text: 'narrow it', streaming: false },
      grep('s2', 'c-s2', 4, '{"pattern":"*.ts"}', searchResult(paths)),
      grep('s3', 'c-s3', 5, '{"pattern":"gone"}', searchResult(undefined, true)),
      grep('s4', 'c-s4', 6, '{"pattern":"deep"}', undefined as never),
    ]), combinedSource())
    expect(model.entries.map(entry => entry.kind)).toEqual([
      'transcript-read-group',
      'transcript-thinking',
      'transcript-search-group',
    ])
    const search = model.entries[2] as unknown as { searches: Array<Record<string, unknown>> }
    expect(search.searches[0]).toMatchObject({
      callId: 'c-s1', pattern: 'export', shape: 'matches',
      files: [{ path: 'a.ts', count: 4, previews: { length: 3 } }], truncated: true, total: 40, state: 'ok',
    })
    expect(search.searches[1]).toMatchObject({ callId: 'c-s2', pattern: '*.ts', shape: 'paths', paths: ['a.ts', 'b.ts'], pathsTotal: 2, state: 'ok' })
    expect(search.searches[2]).toMatchObject({ callId: 'c-s3', pattern: 'gone', state: 'error', error: 'pattern rejected' })
    expect(search.searches[3]).toMatchObject({ callId: 'c-s4', pattern: 'deep', state: 'pending' })
    expect(Object.isFrozen(search)).toBe(true)

    // Degraded search facts: an empty pattern, a paths view without totals,
    // and a blank-text failure keep their arms honest.
    const degraded = conversationTranscriptModel(projection([
      grep('d1', 'c-d1', 1, '{"pattern":""}', searchResult(paths)),
      grep('d2', 'c-d2', 2, '{"pattern":"p"}', searchResult({ shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 })),
      grep('d3', 'c-d3', 3, '{"pattern":"q"}', { content: [{ type: 'text', text: ' \n' }], text: ' \n', isError: true, endedAt: 1 }),
    ]), combinedSource())
    const degradedGroup = degraded.entries[0] as unknown as { searches: Array<Record<string, unknown>> }
    expect(degradedGroup.searches[0]!['pattern']).toBeUndefined()
    expect(degradedGroup.searches[1]).toMatchObject({ shape: 'paths', paths: ['a.ts'], pathsTotal: 1 })
    expect(degradedGroup.searches[2]).toMatchObject({ state: 'error', error: 'search failed' })

    // A read between two searches splits the families apart.
    const split = conversationTranscriptModel(projection([
      grep('s1', 'c-s1', 1, '{"pattern":"a"}', searchResult(paths)),
      transcriptTool({ id: 'r0', callId: 'c-r0', seq: 2, name: 'read', arguments: '{"file_path":"a.ts"}' }),
      grep('s2', 'c-s2', 3, '{"pattern":"b"}', searchResult(paths)),
    ]), combinedSource())
    expect(split.entries.map(entry => entry.kind)).toEqual(['transcript-search-group', 'transcript-read-group', 'transcript-search-group'])
  })
})

describe('OfficialConversationModelSource', () => {
  it('coalesces a token burst before parsing history or invoking tool presenters', () => {
    const entries = projection(Array.from({ length: 300 }, (_, index) => transcriptTool({
      id: String(index), callId: String(index), seq: index,
    }))).entries
    const fixture = sourceFixture(projection(entries), 299)
    const get = vi.fn(() => undefined)
    const publish = vi.fn()
    const source = new OfficialConversationModelSource(fixture.source, { get }, publish)
    source.attach(fixture.session)
    expect(get).not.toHaveBeenCalled()
    expect(source.snapshot().entries).toHaveLength(300)
    get.mockClear()
    publish.mockClear()
    let reads = 0
    for (let seq = 300; seq < 1_300; seq += 1) {
      const value = {
        get entries() {
          reads += 1
          return [...entries, { kind: 'thinking', id: 'live', seq: 300, updatedSeq: seq,
            turn: 1, step: 0, text: `thought ${String(seq)}`, streaming: seq < 1_299 }]
        },
        streaming: seq < 1_299,
      }
      fixture.emit('mayflyConversation', value, seq)
    }
    expect(reads).toBe(0)
    expect(get).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledOnce()
    // A stale callback must not replace the newest pending whole value.
    fixture.emit('mayflyConversation', projection(), 1_298)
    const current = source.snapshot()
    expect(current.entries).toHaveLength(301)
    expect(current.entries.at(-1)).toMatchObject({ text: 'thought 1299', streaming: false })
    expect(current.streaming).toBe(false)
    expect(get).toHaveBeenCalledTimes(300)
    expect(reads).toBe(2)
    expect(source.snapshot()).toBe(current)
    expect(reads).toBe(2)
    source.dispose()
  })

  it('drops unpainted BTW changes on switch, detach, and unload', () => {
    const fixture = sourceFixture(projection(), 0)
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), () => undefined)
    source.attach(fixture.session, 0)
    fixture.emit('mayflyConversation', projection([
      { kind: 'thinking', id: 'btw', seq: 1, turn: 0, step: 0, text: 'pending side thought', streaming: true },
    ]), 1)
    const main = { id: 'main' } as unknown as Session
    source.attach(main)
    fixture.emit('mayflyConversation', projection([
      { kind: 'thinking', id: 'late-btw', seq: 2, turn: 0, step: 0, text: 'late side thought', streaming: true },
    ]), 2)
    expect(source.snapshot()).toMatchObject({ generation: 2, entries: [] })
    fixture.emit('mayflyConversation', projection([transcriptTool()]), 3, main)
    source.attach(null)
    expect(source.snapshot().entries).toEqual([])
    source.attach(main)
    fixture.emit('mayflyConversation', projection([transcriptTool()]), 4, main)
    source.dispose()
    expect(source.snapshot().entries).toEqual([])
  })

  it.each([1_000, 10_000, 100_000])('reads and admits the complete %i-entry history', length => {
    const entries = projection(Array.from({ length }, (_, index) => ({
      kind: 'assistant' as const, id: String(index), seq: index, turn: 0, step: 0, text: 'history', streaming: false,
    }))).entries
    let reads = 0
    const observed = new Proxy(entries, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads += 1
          expect(Number(key)).toBeGreaterThanOrEqual(0)
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const fixture = sourceFixture({ entries: observed, streaming: false })
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), () => undefined)
    source.attach(fixture.session)
    expect(reads).toBe(0)
    expect(source.snapshot().entries).toHaveLength(length)
    expect(reads).toBe(length)
    expect(source.snapshot().entries[0]).toMatchObject({ id: '0' })
    for (let seq = 1; seq <= 3; seq += 1) {
      reads = 0
      fixture.emit('mayflyConversation', { entries: observed, streaming: true }, seq)
      expect(reads).toBe(0)
      expect(source.snapshot().entries).toHaveLength(length)
      expect(reads).toBe(length)
    }
    source.dispose()
  }, 30_000)

  it('selects a complete eligible window across a sparse cutoff suffix without trusting entry order', () => {
    const eligible = Array.from({ length: 250 }, (_, index) => ({
      kind: 'assistant' as const, id: `visible-${String(index)}`, seq: 1_000 + index, turn: 1, step: 0, text: 'visible', streaming: false,
    }))
    const excluded = { kind: 'assistant' as const, id: 'excluded', seq: 1, turn: 0, step: 0, text: 'inherited', streaming: false }
    const value = projection(eligible.flatMap(entry => [entry, excluded]))
    const fixture = sourceFixture(value)
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), () => undefined)
    source.attach(fixture.session, 999)
    expect(source.snapshot().entries).toHaveLength(250)
    expect(source.snapshot().entries[0]).toMatchObject({ id: 'visible-0' })
    expect(source.snapshot().entries.at(-1)).toMatchObject({ id: 'visible-249' })
    expect(source.snapshot().entries).toEqual(conversationTranscriptModel(projection(eligible), toolSource()).entries)
    source.attach(fixture.session, 10_000)
    expect(source.snapshot().entries).toEqual([])
    source.dispose()
  })

  it.each([
    null, undefined, 'bad', [], {}, { entries: [], streaming: 'bad' },
    { entries: [null], streaming: false },
    { entries: [{ kind: 'assistant', seq: 1 }], streaming: false },
  ])('rejects malformed envelopes and visible entries: %j', value => {
    const fixture = sourceFixture(projection())
    const publish = vi.fn()
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), publish)
    source.attach(fixture.session)
    const before = source.snapshot()
    fixture.emit('mayflyConversation', value, 1)
    expect(source.snapshot()).toBe(before)
    expect(publish).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it.each([null, 'bad', {}, { seq: 'bad' }, { seq: NaN }, { seq: 1.5 }])('rejects malformed cutoff candidates: %j', entry => {
    const fixture = sourceFixture(projection())
    const publish = vi.fn()
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), publish)
    source.attach(fixture.session, 0)
    const before = source.snapshot()
    fixture.emit('mayflyConversation', { entries: [entry], streaming: false }, 1)
    expect(source.snapshot()).toBe(before)
    expect(publish).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('leaves full historical schema admission to the native producer', () => {
    const tail = projection(Array.from({ length: 200 }, (_, index) => ({
      kind: 'assistant' as const, id: String(index), seq: index, turn: 0, step: 0, text: 'visible', streaming: false,
    }))).entries
    const fixture = sourceFixture({ entries: [null, ...tail], streaming: false })
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), () => undefined)
    source.attach(fixture.session)
    expect(source.snapshot().entries).toHaveLength(0)
    source.dispose()
  })

  it('passes parsed snapshots to presenters without freezing caller-owned nested tool data', () => {
    const content = [{ type: 'text', text: 'raw' }]
    const result = { content, text: 'raw', isError: false, endedAt: 200 }
    const presentResult = vi.fn((_args: unknown, _result: unknown) => undefined)
    const tools = { get: () => ({ presentResult }) } as unknown as ToolPresentationSource
    const fixture = sourceFixture(projection([transcriptTool({ result })]))
    const source = new OfficialConversationModelSource(fixture.source, tools, () => undefined)
    source.attach(fixture.session)
    source.snapshot()
    expect(presentResult).toHaveBeenCalledOnce()
    const presented = presentResult.mock.calls[0]![1] as { content: unknown[] }
    expect(presented.content).toEqual(content)
    expect(presented.content).not.toBe(content)
    expect(presented.content[0]).not.toBe(content[0])
    expect(Object.isFrozen(content)).toBe(false)
    content[0]!.text = 'changed'
    expect(presented.content[0]).toEqual({ type: 'text', text: 'raw' })
    source.dispose()
  })

  it('reconciles multiple changes, removals, and session switches without retaining history', () => {
    const initial = projection([
      { kind: 'assistant', id: 'one', seq: 1, turn: 0, step: 0, text: 'first', streaming: true },
      { kind: 'thinking', id: 'two', seq: 2, turn: 0, step: 0, text: 'thinking', streaming: true },
    ], true)
    const fixture = sourceFixture(initial, 2)
    const publish = vi.fn()
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), publish)
    source.attach(fixture.session)
    const changed = projection([
      { kind: 'assistant', id: 'one', seq: 1, updatedSeq: 3, turn: 0, step: 0, text: 'settled', streaming: false },
      { kind: 'thinking', id: 'two', seq: 2, updatedSeq: 3, turn: 0, step: 0, text: 'settled thought', streaming: false },
    ])
    fixture.emit('mayflyConversation', changed, 3)
    expect(source.snapshot().entries).toEqual(conversationTranscriptModel(changed, toolSource()).entries)
    fixture.emit('mayflyConversation', projection(), 4)
    expect(source.snapshot().entries).toEqual([])
    const nextSession = { id: 'session-2' } as unknown as Session
    fixture.set(initial, 2)
    source.attach(nextSession)
    expect(source.snapshot().generation).toBe(2)
    const before = source.snapshot()
    fixture.emit('mayflyConversation', changed, 5)
    expect(source.snapshot()).toBe(before)
    fixture.emit('mayflyConversation', changed, 3, nextSession)
    expect(source.snapshot().entries).toEqual(conversationTranscriptModel(changed, toolSource()).entries)
    source.dispose()
    const count = publish.mock.calls.length
    fixture.emit('mayflyConversation', initial, 6, nextSession)
    source.attach(fixture.session)
    expect(publish).toHaveBeenCalledTimes(count)
    expect(source.snapshot().entries).toEqual([])
  })

  it('publishes baseline and live whole values while rejecting stale and malformed changes', () => {
    const f = sourceFixture(projection([
      { kind: 'assistant', id: 'a-1', seq: 1, turn: 0, step: 0, text: 'baseline', streaming: false },
    ]), 4)
    const published: string[] = []
    const source = new OfficialConversationModelSource(f.source, toolSource(), () => {
      const entry = source.snapshot().entries[0]
      published.push(entry?.kind === 'transcript-assistant' ? entry.text : 'empty')
    })
    source.attach(f.session)
    expect(source.snapshot().entries[0]).toMatchObject({ text: 'baseline' })
    expect(published).toEqual(['baseline'])

    f.emit('mayflyConversation', projection([
      { kind: 'assistant', id: 'a-1', seq: 1, turn: 0, step: 0, text: 'baseline updated', streaming: true },
    ], true), 5)
    expect(source.snapshot().entries[0]).toMatchObject({ text: 'baseline updated', streaming: true })
    expect(published).toEqual(['baseline', 'baseline updated'])

    f.emit('other', projection(), 6)
    f.emit('mayflyConversation', projection(), 5)
    f.emit('mayflyConversation', { entries: 'bad', streaming: false }, 6)
    expect(published).toEqual(['baseline', 'baseline updated', 'baseline updated'])

    f.emit('mayflyConversation', projection([
      { kind: 'assistant', id: 'a-2', seq: 5, turn: 0, step: 0, text: 'live', streaming: true },
    ], true), 6)
    expect(source.snapshot().streaming).toBe(true)
    expect(published).toEqual(['baseline', 'baseline updated', 'baseline updated', 'live'])

    // Whole-value replacement must not preserve entries from the prior view.
    f.emit('mayflyConversation', projection([
      { kind: 'assistant', id: 'a-3', seq: 7, turn: 0, step: 0, text: 'replacement', streaming: true },
    ], true), 7)
    expect(published.at(-1)).toBe('replacement')
    f.emit('mayflyConversation', projection([
      { kind: 'user', id: 'u-8', seq: 8, turn: 0, text: 'user replacement', images: [] },
    ], true), 8)
    expect(published.at(-1)).toBe('empty')

    f.set({ entries: 'bad', streaming: false }, 7)
    source.attach(f.session)
    expect(source.snapshot().entries).toEqual([])
    source.attach(null)
    expect(published.at(-1)).toBe('empty')
    source.dispose()
    source.dispose()
    f.emit('mayflyConversation', projection(), 8)
    expect(f.off).toHaveBeenCalledOnce()
  })

  it('accepts a projection snapshot without sequence metadata', () => {
    const fixture = sourceFixture(projection(), 4)
    fixture.set(projection([
      { kind: 'assistant', id: 'a-1', seq: 1, turn: 0, step: 0, text: 'baseline', streaming: false },
    ]), -1)
    const source = new OfficialConversationModelSource(fixture.source, toolSource(), () => undefined)
    source.attach(fixture.session)
    expect(source.snapshot().entries[0]).toMatchObject({ text: 'baseline' })
    source.dispose()
  })

  it('hides inherited entries after an auxiliary transcript cut while retaining later updates', () => {
    const f = sourceFixture(projection([
      { kind: 'user', id: 'history-user', seq: 1, turn: 1, text: 'main history', images: [] },
      { kind: 'assistant', id: 'history-answer', seq: 2, turn: 1, step: 0, text: 'main answer', streaming: false },
      { kind: 'user', id: 'btw-user', seq: 3, turn: 2, text: 'side question', images: [] },
      { kind: 'assistant', id: 'btw-answer', seq: 4, turn: 2, step: 0, text: 'side answer', streaming: true },
    ], true), 4)
    const published: string[][] = []
    const source = new OfficialConversationModelSource(f.source, toolSource(), () => {
      published.push(source.snapshot().entries.map(entry => 'text' in entry ? entry.text : entry.kind))
    })
    source.attach(f.session, 2)
    expect(source.snapshot().entries).toMatchObject([
      { kind: 'transcript-user', text: 'side question' },
      { kind: 'transcript-assistant', text: 'side answer' },
    ])
    f.emit('mayflyConversation', projection([
      { kind: 'user', id: 'history-user', seq: 1, turn: 1, text: 'main history', images: [] },
      { kind: 'assistant', id: 'history-answer', seq: 2, turn: 1, step: 0, text: 'main answer', streaming: false },
      { kind: 'user', id: 'btw-user', seq: 3, turn: 2, text: 'side question', images: [] },
      { kind: 'assistant', id: 'btw-answer', seq: 4, turn: 2, step: 0, text: 'side answer updated', streaming: false },
    ], false), 5)
    expect(source.snapshot().entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'main history' })]))
    expect(source.snapshot().entries).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'side answer updated' })]))
    expect(published.at(-1)).toEqual(['side question', 'side answer updated'])
    source.attach(f.session)
    expect(source.snapshot().entries).toHaveLength(4)
    source.dispose()
  })
})
