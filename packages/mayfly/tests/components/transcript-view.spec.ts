/**
 * Decision tests of the conversation stream: the turn rule and its time, the prompt row and its four-line cap, the
 * queued rows, the answer and reasoning rows, and the identity that keeps the list's row cache hitting.
 * @module components-transcript-view
 */

import { describe, expect, it } from 'vitest'
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import { latestTurnOf, PROMPT_MAX_LINES, streamTarget, TranscriptStream, TranscriptView, type StreamRow, type StreamTurn, type TranscriptViewFacts } from '../../src/components/transcript-view.ts'

const prompt = (id: string, text: string, more: Partial<Extract<StreamRow, { kind: 'prompt' }>> = {}): StreamRow => ({ kind: 'prompt', id, text, images: [], open: false, ...more })
const answer = (id: string, text: string): StreamRow => ({ kind: 'answer', id, text })
const turn = (id: string, rows: readonly StreamRow[], closing?: string): StreamTurn => ({ id, number: Number(id.slice('turn:'.length)), rows, ...(closing === undefined ? {} : { closing }) })
const facts = (turns: readonly StreamTurn[], queued: TranscriptViewFacts['queued'] = []): TranscriptViewFacts => ({ turns, queued })
const itemsOf = (value: TranscriptViewFacts) => TranscriptView(value).items

describe('TranscriptView', () => {
  it('is one browse list of the stream', () => {
    const node = TranscriptView(facts([turn('turn:1', [prompt('u1', 'hello')])]))
    expect(node).toMatchObject({ kind: 'list', id: 'stream', role: 'browse', acceptVerb: 'expand', hintLabel: 'stream' })
  })

  it('opens every turn after the first with a blank row and closes an ended turn with one muted row', () => {
    const items = itemsOf(facts([
      turn('turn:1', [prompt('u1', 'one'), answer('a1', 'first')], 'Worked for 17s · done 10:13'),
      turn('turn:2', [prompt('u2', 'two')], 'Stopped after 3s · done 10:14'),
      turn('turn:3', [prompt('u3', 'three')]),
    ]))
    // Every row after the first of the stream opens with a blank row.
    expect(items.map(item => item.id)).toEqual(['u1', 'a1.gap', 'a1', 'turn:1.end.gap', 'turn:1.end', 'turn:2.gap', 'u2', 'turn:2.end.gap', 'turn:2.end', 'turn:3.gap', 'u3'])
    expect(items.find(item => item.id === 'turn:1.end')).toMatchObject({ label: '✻ Worked for 17s · done 10:13', labelSpans: [{ text: '✻ ', tone: 'muted' }, { text: 'Worked for 17s · done 10:13', tone: 'muted' }] })
    expect(items.find(item => item.id === 'turn:2.gap')).toMatchObject({ gap: true, disabled: true })
    // No line is drawn anywhere, and a running turn has no closing row.
    expect(items.some(item => item.rule !== undefined)).toBe(false)
    expect(items.some(item => item.id === 'turn:3.end')).toBe(false)
  })

  it('wraps the prompt under its marker and caps it at four lines until it is open', () => {
    expect(PROMPT_MAX_LINES).toBe(4)
    const closed = itemsOf(facts([turn('turn:1', [prompt('u1', 'a\nb\nc\nd\ne\nf')])]))[0]!
    expect(closed).toMatchObject({ wrap: true, wrapMax: 4, hang: 2 })
    expect(closed.labelSpans?.[0]).toEqual({ text: '» ', tone: 'user' })
    const open = itemsOf(facts([turn('turn:1', [prompt('u1', 'a\nb\nc\nd\ne\nf', { open: true })])]))[0]!
    expect(open.wrap).toBe(true)
    expect(open.wrapMax).toBeUndefined()
  })

  it('puts each attached image under the prompt as a picture with its text fallback', () => {
    const items = itemsOf(facts([turn('turn:1', [prompt('u1', 'look', { images: [{ attachmentId: 'att-1', alt: '[image] 1 · 1×1 · 1 KB' }] })])]))
    expect(items.map(item => item.id)).toEqual(['u1', 'u1.image.0'])
    expect(items[1]).toMatchObject({
      label: '[image] 1 · 1×1 · 1 KB', bodyAlways: true, bodyLead: [{ text: '  ▪ ', tone: 'muted' }],
      body: { kind: 'image', attachmentId: 'att-1', alt: '[image] 1 · 1×1 · 1 KB', maxRows: 12 },
    })
  })

  it('puts the messages queued behind the stream after the last turn, marked as queued', () => {
    const items = itemsOf(facts([turn('turn:1', [prompt('u1', 'one')])], [{ id: 'q1', text: 'then update the changelog', suffix: '⏎ queued' }]))
    expect(items.map(item => item.id)).toEqual(['u1', 'queued.q1.gap', 'queued.q1'])
    const queued = items.at(-1)!
    expect(queued.labelSpans?.at(-1)).toEqual({ text: '  ⏎ queued', tone: 'muted' })
    expect(queued).toMatchObject({ wrap: true, wrapMax: 4 })
  })

  it('draws an answer as one item whose Markdown body wraps under the bullet that leads it', () => {
    const items = itemsOf(facts([turn('turn:1', [answer('a1', 'Summary\n\n- one\n  - nested')])]))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'a1', label: '', bodyAlways: true, bodyLead: [{ text: '● ' }], body: { kind: 'markdown', source: 'Summary\n\n- one\n  - nested' } })
  })

  it('draws reasoning as a label row with its rows under it, aligned past the mark', () => {
    const items = itemsOf(facts([turn('turn:1', [
      { kind: 'reasoning', id: 'r1', label: 'Thinking', rows: ['check the factors'] },
      { kind: 'reasoning', id: 'r2', label: 'Thinking · 9s', rows: ['first', 'second'], more: '… +3 more · Ctrl+O' },
    ])]))
    expect(items.map(item => item.id)).toEqual(['r1', 'r1.row.0', 'r2.gap', 'r2', 'r2.row.0', 'r2.row.1', 'r2.more'])
    expect(items[0]).toMatchObject({ label: '✻ Thinking', labelSpans: [{ text: '✻ ', tone: 'muted' }, { text: 'Thinking', tone: 'muted' }] })
    // The rows start in the column of the label's first letter: the two columns of `✻ ` lead them.
    expect(items[1]).toMatchObject({ label: '  check the factors', labelSpans: [{ text: '  ' }, { text: 'check the factors', tone: 'muted' }] })
    expect(items[3]).toMatchObject({ label: '✻ Thinking · 9s' })
    expect(items[6]).toMatchObject({ label: '  … +3 more · Ctrl+O', disabled: true })
  })

  it('draws a live reasoning block with a breathing dot and the earlier lines above its rows', () => {
    const items = itemsOf(facts([turn('turn:1', [{ kind: 'reasoning', id: 'r1', label: 'Thinking', pending: true, rows: ['b'], earlier: '… +4 earlier' }])]))
    expect(items.map(item => item.id)).toEqual(['r1', 'r1.earlier', 'r1.row.0'])
    expect(items[0]).toMatchObject({ bodyAlways: true, bodyLead: [{ text: '' }] })
    expect(items[1]).toMatchObject({ label: '  … +4 earlier' })
  })

  it('reports the newest turn, so the screen counts turns of the agent loop and never rows inside one', () => {
    expect(latestTurnOf(facts([]))).toBe(0)
    expect(latestTurnOf(facts([turn('turn:4', [prompt('u4', 'go')]), turn('turn:5', [prompt('u5', 'again'), answer('a5', 'done')])], [{ id: 'q', text: 'later', suffix: '⏎ queued' }]))).toBe(5)
    // The window drops old turns without lowering the number.
    expect(latestTurnOf(facts([turn('turn:15', [prompt('u15', 'x')]), turn('turn:16', [prompt('u16', 'y')])]))).toBe(16)
  })

  it('numbers a repeated id instead of letting the list be refused whole', () => {
    const items = itemsOf(facts([turn('turn:1', [prompt('u1', 'one'), prompt('u1', 'one again')])], [{ id: 'q', text: 'x', suffix: '⏎ queued' }, { id: 'q', text: 'y', suffix: '⏎ queued' }]))
    const ids = items.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['u1', 'u1.gap', 'u1~2', 'queued.q.gap', 'queued.q', 'queued.q.gap~2', 'queued.q~2'])
    // The nodes still admit as a stream.
    expect(() => freezeWire(TranscriptView(facts([turn('turn:1', [prompt('u1', 'a'), prompt('u1', 'b')])])))).not.toThrow()
  })

  it('draws the cut turn marker as its translated text', () => {
    const items = itemsOf(facts([turn('turn:1', [{ kind: 'interrupted', id: 'i1', text: '■ interrupted' }])]))
    expect(items[0]!.labelSpans).toEqual([{ text: '■ interrupted', tone: 'warning' }])
  })

  it('keeps the frozen items of a row while its facts keep their identity', () => {
    const settled = answer('a1', 'done')
    const first = turn('turn:1', [prompt('u1', 'one'), settled], 'Worked for 1s · done 10:02')
    const second = turn('turn:2', [prompt('u2', 'two')])
    const before = itemsOf(facts([first, second]))
    // The live turn changes; the settled one is the same object, so its items are the same objects.
    const live = turn('turn:2', [prompt('u2', 'two'), answer('a2', 'streaming…')])
    const after = itemsOf(facts([first, live]))
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    // A turn rebuilt with equal facts but a new object still reuses its rows' items.
    expect(itemsOf(facts([first, turn('turn:2', second.rows)]))[2]).not.toBe(undefined)
    expect(Object.isFrozen(before[0])).toBe(true)
    // A row with new facts gets new items.
    expect(itemsOf(facts([turn('turn:1', [prompt('u1', 'one'), answer('a1', 'done more')], 'Worked for 1s · done 10:02')]))[1]).not.toBe(before[1])
  })

  it('puts the blocks that follow a closed turn after its closing row, each behind a blank row', () => {
    const compact: StreamRow = { kind: 'note', id: 'c1', text: 'compacted' }
    const withAfter: StreamTurn = { ...turn('turn:1', [prompt('u1', 'one')], 'Worked for 1s · done 10:02'), after: [compact] }
    expect(itemsOf(facts([withAfter])).map(item => item.id)).toEqual(['u1', 'turn:1.end.gap', 'turn:1.end', 'c1.gap', 'c1'])
  })

  it('draws a tool block\'s hunks and code from the line they start at, and a run of calls as its head with a row per call', () => {
    const tool: StreamRow = {
      kind: 'tool', id: 't1', state: 'ok', name: 'Edit', target: 'a.ts',
      diff: [{ before: 'a', after: 'b', start: 4, beforeStart: 5 }],
      code: { text: 'x = 1', start: 7 },
    }
    const ids = itemsOf(facts([turn('turn:1', [tool])])).map(item => item.id)
    expect(ids).toEqual(['t1', 't1.diff.0', 't1.code'])
    const diff = itemsOf(facts([turn('turn:1', [tool])]))[1]!.body
    expect(diff).toMatchObject({ kind: 'diff', start: 4, beforeStart: 5 })
    expect(itemsOf(facts([turn('turn:1', [tool])]))[2]!.body).toMatchObject({ kind: 'code', start: 7 })
    expect(diff).not.toHaveProperty('language')
    const run: StreamRow = { kind: 'tools', id: 'r1', state: 'ok', name: 'Bash', head: '2 calls', items: [{ state: 'ok', label: 'ls' }, { state: 'ok', label: 'pwd' }] }
    expect(itemsOf(facts([turn('turn:1', [run])])).map(item => item.id)).toEqual(['r1', 'r1.item.0', 'r1.item.1'])
  })

  it('sends the cursor to the newest row it can stand on, or to the first of the rows it is given that is drawn', () => {
    const value = facts([turn('turn:1', [prompt('u1', 'one'), answer('a1', 'first')], 'Worked for 1s · done 10:02')])
    // The closing row and the blanks between rows are not rows the cursor stands on.
    expect(TranscriptView(value, { rev: 1 }).focusItem).toEqual({ id: 'a1', rev: 1 })
    expect(TranscriptView(value, { rev: 2, ids: ['gone', 'u1', 'a1'] }).focusItem).toEqual({ id: 'u1', rev: 2 })
    // A row that is no longer drawn leaves the cursor where it is.
    expect(TranscriptView(value, { rev: 3, ids: ['gone'] }).focusItem).toBeUndefined()
    expect(TranscriptView(value).focusItem).toBeUndefined()
  })

  it('reads the row the cursor was sent to from the list or from the stream that holds it, and nothing from another node', () => {
    const value = facts([turn('turn:1', [prompt('u1', 'one')])])
    expect(streamTarget(TranscriptView(value, { rev: 1 }))).toBe('u1')
    expect(streamTarget(TranscriptStream(value, { rev: 1 }))).toBe('u1')
    expect(streamTarget(TranscriptStream(value))).toBeUndefined()
    // The keys that sit beside the list are no list to read a cursor from.
    const stream = TranscriptStream(value, { rev: 1 })
    const keys = stream.kind === 'stack' ? stream.children[1]!.node : undefined
    expect(keys?.kind).toBe('actions')
    expect(streamTarget(keys!)).toBeUndefined()
  })
})
