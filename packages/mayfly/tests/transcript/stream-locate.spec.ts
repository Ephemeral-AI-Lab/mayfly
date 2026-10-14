/** The owner index of the stream: which stream row or item stands for which entries and calls (`locate`), the text and raw content behind an item (`textOf`), and the row that draws a part (`rowOf`). */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, type TranscriptViewMode } from '../../src/transcript/presentation-policy.ts'
import { NO_DISCLOSURE, type Disclosure } from '../../src/transcript/disclosure.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'

const t = interpolateLocaleMessage
const base = (turn: number) => ({ seq: 1, updatedSeq: 1, turn })
const user: TranscriptEntryModel = { ...base(1), id: 'user:1', kind: 'transcript-user', text: 'go', images: [] }
const answer: TranscriptEntryModel = { ...base(1), id: 'assistant:1', kind: 'transcript-assistant', step: 2, text: 'done', streaming: false }
const web = (id: string, query: string): TranscriptEntryModel => ({
  ...base(1), id, kind: 'transcript-tool', step: 1, callId: id, name: 'web_search', family: 'web', activity: 'webSearch', detail: query, arguments: '{}', startedAt: 0,
  web: { kind: 'search', sources: [{ url: 'https://a.dev' }], truncated: false }, result: { text: `result ${query}`, isError: false, endedAt: 1_000 },
} as unknown as TranscriptEntryModel)
const read = (callId: string, path: string) => ({ callId, activity: 'read', detail: path, seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'read', startedAt: 0, endedAt: 1, state: 'ok', path, range: { first: 1, last: 2 }, totalLines: 2, previewLines: [{ number: 1, text: 'x' }] })
const readGroup: TranscriptEntryModel = { ...base(1), id: 'read:1', kind: 'transcript-read-group', step: 0, reads: [read('r1', 'a.ts'), read('r2', 'b.ts')] } as unknown as TranscriptEntryModel
const turns = [{ turn: 1, startedAt: 0, endedAt: 9_000, outcome: 'completed' }] as never

/** The facts of a model under one level, with the facts object kept so its owner index can be asked. */
function built(mode: TranscriptViewMode, entries: TranscriptEntryModel[], disclosure: Disclosure = NO_DISCLOSURE) {
  const stream = new StreamFacts()
  const policy = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode, process: PROCESS_POLICIES[mode] }
  const inputs: StreamInputs = { policy, disclosure, liveTurnHeader: false, t, now: 9_000, queued: [] }
  stream.build(createTranscriptModel('spec', entries, false, 0, turns), inputs)
  return stream
}

describe('locate', () => {
  it('finds the entry behind a row, and the turn behind a header, a title, and the closing line', () => {
    const stream = built('standard', [user, web('w1', 'a'), answer])
    expect(stream.locate('user:1')).toEqual({ kind: 'entries', turn: 1, parts: ['user:1'] })
    expect(stream.locate('turn-header:1')).toEqual({ kind: 'header', turn: 1, parts: [] })
    expect(stream.locate('turn:1.end')).toEqual({ kind: 'header', turn: 1, parts: [] })
    expect(stream.locate('turn:-1.end')).toEqual({ kind: 'header', turn: -1, parts: [] })
    const compact = built('compact', [user, web('w1', 'a'), answer])
    expect(compact.locate('process:1')).toEqual({ kind: 'title', turn: 1, parts: [] })
  })

  it('reads a suffixed item (a body, a more line) as the row it belongs to', () => {
    const stream = built('verbose', [user, web('w1', 'a')])
    expect(stream.locate('w1.body')).toEqual(stream.locate('w1'))
    expect(stream.locate('w1.more')).toEqual(stream.locate('w1'))
  })

  it('finds a call of a run by its item id, and the run head by its own', () => {
    const stream = built('standard', [user, web('w1', 'a'), web('w2', 'b')], { ...NO_DISCLOSURE, rows: new Set(['w2']) })
    expect(stream.locate('w1')).toEqual({ kind: 'entries', turn: 1, parts: ['w1', 'w2'], run: { head: 'w1', calls: ['w1', 'w2'] } })
    expect(stream.locate('w1.item.1')).toEqual({ kind: 'entries', turn: 1, parts: ['w2'], run: { head: 'w1', calls: ['w1', 'w2'] } })
  })

  it('finds nothing for an item no entry stands behind', () => {
    const stream = built('standard', [user])
    expect(stream.locate('queued:9')).toBeUndefined()
    expect(stream.locate('blank:1')).toBeUndefined()
    expect(new StreamFacts().locate('user:1')).toBeUndefined()
  })
})

describe('textOf', () => {
  it('gives an entry as a person reads it, or as the model JSON in raw mode', () => {
    const stream = built('standard', [user, answer])
    expect(stream.textOf('user:1', 'text')).toBe('go')
    expect(stream.textOf('user:1', 'raw')).toBe(JSON.stringify(user, null, 2))
  })

  it('gives a header or the closing line the whole turn, its entries joined by a blank line', () => {
    const stream = built('standard', [user, web('w1', 'a'), answer])
    expect(stream.textOf('turn-header:1', 'text')).toBe('go\n\nweb_search(a)\nhttps://a.dev\nresult a\n\ndone')
    expect(stream.textOf('turn:1.end', 'text')).toBe(stream.textOf('turn-header:1', 'text'))
    // Raw mode of several entries is a JSON array, so the copy is one valid document.
    const raw = stream.textOf('turn-header:1', 'raw')!
    expect(raw.startsWith('[\n{\n')).toBe(true)
    expect(raw.endsWith('\n}\n]')).toBe(true)
    expect(JSON.parse(raw)).toHaveLength(3)
  })

  it('gives a run head all its calls, and a call row only its own call', () => {
    const stream = built('standard', [user, web('w1', 'a'), web('w2', 'b')], { ...NO_DISCLOSURE, rows: new Set(['w2']) })
    expect(stream.textOf('w1', 'text')).toBe('web_search(a)\nhttps://a.dev\nresult a\n\nweb_search(b)\nhttps://a.dev\nresult b')
    expect(stream.textOf('w1.item.1', 'text')).toBe('web_search(b)\nhttps://a.dev\nresult b')
    expect(JSON.parse(stream.textOf('w1.item.1', 'raw')!)).toMatchObject({ id: 'w2', name: 'web_search', detail: 'b' })
  })

  it('gives a read call its own lines, not the whole group', () => {
    const stream = built('verbose', [user, readGroup])
    expect(stream.textOf('read:1:r2', 'text')).toBe('b.ts\n    1  x')
    expect(stream.textOf('read:1', 'text')).toBeUndefined()
  })

  it('finds nothing for an item no entry stands behind, and without a model', () => {
    const stream = built('standard', [user])
    expect(stream.textOf('queued:9', 'text')).toBeUndefined()
    expect(new StreamFacts().textOf('user:1', 'text')).toBeUndefined()
  })
})

describe('rowOf', () => {
  it('names the row that draws an entry, a reasoning block, and a call of a run under its head', () => {
    const stream = built('standard', [user, readGroup, answer])
    expect(stream.rowOf('user:1')).toBe('user:1')
    expect(stream.rowOf('assistant:1')).toBe('assistant:1')
    expect(stream.rowOf('read:1:r1')).toBe('read:1:r1.item.0')
    expect(stream.rowOf('read:1:r2')).toBe('read:1:r1.item.1')
  })

  it('names the call row itself when the call is drawn as a block of its own (Verbose)', () => {
    const stream = built('verbose', [user, readGroup])
    expect(stream.rowOf('read:1:r2')).toBe('read:1:r2')
  })

  it('names nothing for a part the level does not draw, so a search hit there is passed over', () => {
    const stream = built('compact', [user, readGroup, answer])
    expect(stream.rowOf('read:1:r1')).toBeUndefined()
    expect(stream.rowOf('nope:1')).toBeUndefined()
  })
})
