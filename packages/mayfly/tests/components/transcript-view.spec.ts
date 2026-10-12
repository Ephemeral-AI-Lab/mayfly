/**
 * Decision tests of the conversation stream: the turn rule and its time, the prompt row and its four-line cap, the
 * queued rows, the answer's blank lines, and the identity that keeps the list's row cache hitting.
 * @module components-transcript-view
 */

import { describe, expect, it } from 'vitest'
import { PROMPT_MAX_LINES, TranscriptView, type StreamRow, type StreamTurn, type TranscriptViewFacts } from '../../src/components/transcript-view.ts'

const prompt = (id: string, text: string, more: Partial<Extract<StreamRow, { kind: 'prompt' }>> = {}): StreamRow => ({ kind: 'prompt', id, text, images: [], open: false, ...more })
const answer = (id: string, text: string): StreamRow => ({ kind: 'answer', id, text })
const turn = (id: string, rows: readonly StreamRow[], time?: string): StreamTurn => ({ id, rows, ...(time === undefined ? {} : { time }) })
const facts = (turns: readonly StreamTurn[], queued: TranscriptViewFacts['queued'] = []): TranscriptViewFacts => ({ turns, queued })
const itemsOf = (value: TranscriptViewFacts) => TranscriptView(value).items

describe('TranscriptView', () => {
  it('is one browse list of the stream', () => {
    const node = TranscriptView(facts([turn('turn:1', [prompt('u1', 'hello')])]))
    expect(node).toMatchObject({ kind: 'list', id: 'stream', role: 'browse', acceptVerb: 'expand', hintLabel: 'stream' })
  })

  it('opens every turn after the first with a blank row and a rule carrying its start time', () => {
    const items = itemsOf(facts([
      turn('turn:1', [prompt('u1', 'one'), answer('a1', 'first')], '10:02'),
      turn('turn:2', [prompt('u2', 'two')], '10:03'),
      turn('turn:3', [prompt('u3', 'three')]),
    ]))
    expect(items.map(item => item.id)).toEqual(['u1', 'a1.0', 'turn:2.gap', 'turn:2.rule', 'u2', 'turn:3.gap', 'turn:3.rule', 'u3'])
    expect(items.find(item => item.id === 'turn:2.rule')).toMatchObject({ rule: '10:03', disabled: true })
    // A turn that recorded no start still gets its rule, without a time.
    expect(items.find(item => item.id === 'turn:3.rule')).toMatchObject({ rule: '' })
    expect(items.find(item => item.id === 'turn:2.gap')).toMatchObject({ gap: true, disabled: true })
  })

  it('wraps the prompt under its marker and caps it at four lines until it is open', () => {
    expect(PROMPT_MAX_LINES).toBe(4)
    const closed = itemsOf(facts([turn('turn:1', [prompt('u1', 'a\nb\nc\nd\ne\nf')])]))[0]!
    expect(closed).toMatchObject({ wrap: true, wrapMax: 4 })
    expect(closed.labelSpans?.[0]).toEqual({ text: '» ', tone: 'user' })
    const open = itemsOf(facts([turn('turn:1', [prompt('u1', 'a\nb\nc\nd\ne\nf', { open: true })])]))[0]!
    expect(open.wrap).toBe(true)
    expect(open.wrapMax).toBeUndefined()
  })

  it('lists attached images under the prompt', () => {
    const items = itemsOf(facts([turn('turn:1', [prompt('u1', 'look', { images: ['[image] 1 · 1×1 · 1 KB'] })])]))
    expect(items.map(item => item.id)).toEqual(['u1', 'u1.image.0'])
    expect(items[1]!.label).toBe('  ▪ [image] 1 · 1×1 · 1 KB')
  })

  it('puts the messages queued behind the stream after the last turn, marked as queued', () => {
    const items = itemsOf(facts([turn('turn:1', [prompt('u1', 'one')])], [{ id: 'q1', text: 'then update the changelog', suffix: '⏎ queued' }]))
    expect(items.map(item => item.id)).toEqual(['u1', 'queued.q1.gap', 'queued.q1.rule', 'queued.q1'])
    const queued = items.at(-1)!
    expect(queued.labelSpans?.at(-1)).toEqual({ text: '  ⏎ queued', tone: 'muted' })
    expect(queued).toMatchObject({ wrap: true, wrapMax: 4 })
  })

  it('draws an answer line by line so its blank lines and layout survive', () => {
    const items = itemsOf(facts([turn('turn:1', [answer('a1', 'Summary\n\n- one\n  - nested')])]))
    expect(items.map(item => item.id)).toEqual(['a1.0', 'a1.1', 'a1.2', 'a1.3'])
    expect(items[0]!.label).toBe('● Summary')
    expect(items[1]).toMatchObject({ gap: true })
    expect(items[3]!.label).toBe('    - nested')
  })

  it('draws the cut turn marker as its translated text', () => {
    const items = itemsOf(facts([turn('turn:1', [{ kind: 'interrupted', id: 'i1', text: '■ interrupted' }])]))
    expect(items[0]!.labelSpans).toEqual([{ text: '■ interrupted', tone: 'warning' }])
  })

  it('keeps the frozen items of a row while its facts keep their identity', () => {
    const settled = answer('a1', 'done')
    const first = turn('turn:1', [prompt('u1', 'one'), settled], '10:02')
    const second = turn('turn:2', [prompt('u2', 'two')], '10:03')
    const before = itemsOf(facts([first, second]))
    // The live turn changes; the settled one is the same object, so its items are the same objects.
    const live = turn('turn:2', [prompt('u2', 'two'), answer('a2', 'streaming…')], '10:03')
    const after = itemsOf(facts([first, live]))
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    // A turn rebuilt with equal facts but a new object still reuses its rows' items.
    expect(itemsOf(facts([first, turn('turn:2', second.rows, '10:03')]))[2]).not.toBe(undefined)
    expect(Object.isFrozen(before[0])).toBe(true)
    // A row with new facts gets new items.
    expect(itemsOf(facts([turn('turn:1', [prompt('u1', 'one'), answer('a1', 'done more')], '10:02')]))[1]).not.toBe(before[1])
  })
})
