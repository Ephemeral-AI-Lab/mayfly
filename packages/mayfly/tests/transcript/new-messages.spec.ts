/**
 * The new-messages marker: which stream ids count as messages, the boundary
 * between seen and unseen rows, the marker row's stable identity and its
 * placement before a turn or a trailing block, the layout clock that dismisses
 * it after five visible seconds, the Ctrl+↓ jump target, and reset.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  NEW_MESSAGES_HISTORY_ROWS,
  NEW_MESSAGES_VISIBLE_MS,
  NewMessages,
  messageRowIds,
  type NewMessagesHost,
} from '../../src/transcript/new-messages.ts'
import type { StreamRow, StreamTurn, TranscriptViewFacts } from '../../src/components/transcript-view.ts'

type Tail = { readonly away: boolean, readonly top: number, readonly viewport: number }

function row(kind: StreamRow['kind'], id: string, extra: Record<string, unknown> = {}): StreamRow {
  return { kind, id, ...extra } as StreamRow
}

function turn(id: string, rows: readonly StreamRow[], after?: readonly StreamRow[]): StreamTurn {
  return { id, number: 1, rows, ...(after === undefined ? {} : { after }) }
}

function facts(turns: readonly StreamTurn[]): TranscriptViewFacts {
  return { turns, queued: [] }
}

/** A host whose tail, marker row, and clock are scripted. */
class FakeHost implements NewMessagesHost {
  tailValue: Tail | undefined = undefined
  rowValue: number | undefined = undefined
  nowValue = 0
  readonly scrolls: number[] = []
  follows = 0
  republishes = 0
  readonly timers = new Map<number, { readonly callback: () => void, readonly ms: number }>()
  readonly cleared: number[] = []
  private nextHandle = 1

  tail(): Tail | undefined { return this.tailValue }
  row(): number | undefined { return this.rowValue }
  scrollTo(rowNumber: number): void { this.scrolls.push(rowNumber) }
  scrollUp(rows: number): void { this.scrolls.push(-rows) }
  follow(): void { this.follows += 1 }
  republish(): void { this.republishes += 1 }
  now(): number { return this.nowValue }
  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, { callback, ms })
    return handle
  }
  clearTimeout(handle: unknown): void {
    this.cleared.push(handle as number)
    this.timers.delete(handle as number)
  }

  fire(handle = this.nextHandle - 1): void {
    const timer = this.timers.get(handle)
    this.timers.delete(handle)
    timer?.callback()
  }
}

let host: FakeHost
beforeEach(() => { host = new FakeHost() })

describe('messageRowIds', () => {
  it('takes the message rows of turns and trailing blocks, oldest first, without structure or queued rows', () => {
    const stream = facts([
      turn('t1', [
        row('header', 'h'),
        row('prompt', 'p'),
        row('title', 'fold'),
        row('answer', 'a'),
        row('new-messages', 'marker'),
      ]),
      turn('t2', [row('header', 'h2')], [row('tool', 'tool'), row('note', 'n'), row('header', 'ha')]),
    ])
    expect(messageRowIds(stream)).toEqual(['p', 'a', 'tool', 'n'])
  })

  it('is empty for a stream without turns', () => {
    expect(messageRowIds(facts([]))).toEqual([])
  })
})

describe('observe', () => {
  it('records the tail while the reader is at it and leaves no boundary', () => {
    const marker = new NewMessages(host)
    expect(marker.observe(['a', 'b'], false)).toBeUndefined()
    expect(marker.pending).toBe(false)
    expect(marker.rowId).toBeUndefined()
  })

  it('marks the first row after the last one seen when the reader leaves the tail', () => {
    const marker = new NewMessages(host)
    marker.observe(['a', 'b'], false)
    expect(marker.observe(['a', 'b', 'c', 'd'], true)).toBe('c')
    expect(marker.pending).toBe(true)
    expect(marker.rowId).toBe('new-messages')
    // Seeing the same stream again keeps the same boundary.
    expect(marker.observe(['a', 'b', 'c', 'd'], true)).toBe('c')
  })

  it('clears when none of the rows from the tail survives (another conversation or a rewind)', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    expect(marker.observe(['x', 'y'], true)).toBeUndefined()
    expect(marker.pending).toBe(false)
  })

  it('clears when the reader caught up with the boundary and nothing newer is left', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    expect(marker.pending).toBe(true)
    expect(marker.observe(['a'], false)).toBeUndefined()
    expect(marker.pending).toBe(false)
  })

  it('clears immediately when leaving before any rows were recorded', () => {
    const marker = new NewMessages(host)
    expect(marker.observe(['a'], true)).toBeUndefined()
    expect(marker.pending).toBe(false)
  })

  it('keeps the existing boundary while the stream is unchanged', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    expect(marker.observe(['a', 'b'], true)).toBe('b')
    expect(marker.pending).toBe(true)
  })
})

describe('insert', () => {
  it('puts the rule before the boundary row and leaves other turns by identity', () => {
    const marker = new NewMessages(host)
    const first = turn('t1', [row('header', 'h'), row('prompt', 'p'), row('answer', 'a')])
    const second = turn('t2', [row('answer', 'b')])
    const built = facts([first, second])
    const inserted = marker.insert(built, 'a', 'New messages')
    expect(inserted.turns[0]!.rows.map(item => item.id)).toEqual(['h', 'p', 'new-messages', 'a'])
    expect(inserted.turns[1]).toBe(second)
    expect(inserted.turns[0]!.rows[2]).toMatchObject({ kind: 'new-messages', id: 'new-messages', text: 'New messages' })
    expect(inserted.queued).toBe(built.queued)
  })

  it('keeps the turn header above the rule when the boundary is the first message', () => {
    const marker = new NewMessages(host)
    const inserted = marker.insert(facts([turn('t1', [row('header', 'h'), row('prompt', 'p')])]), 'p', 'New messages')
    expect(inserted.turns[0]!.rows.map(item => item.id)).toEqual(['new-messages', 'h', 'p'])
  })

  it('puts the rule into the trailing block when the boundary lives there', () => {
    const marker = new NewMessages(host)
    const inserted = marker.insert(
      facts([turn('t1', [row('answer', 'a')], [row('header', 'h'), row('compaction', 'c')])]),
      'c',
      'New messages',
    )
    expect(inserted.turns[0]!.rows.map(item => item.id)).toEqual(['a'])
    expect(inserted.turns[0]!.after?.map(item => item.id)).toEqual(['new-messages', 'h', 'c'])
  })

  it('leaves facts unchanged when the boundary row is not in the stream', () => {
    const marker = new NewMessages(host)
    const built = facts([turn('t1', [row('answer', 'a')])])
    expect(marker.insert(built, 'missing', 'New messages')).toBe(built)
  })

  it('reuses the marker row while its text stays and the whole result while the turn and boundary stay', () => {
    const marker = new NewMessages(host)
    const built = facts([turn('t1', [row('answer', 'a')])])
    const first = marker.insert(built, 'a', 'New messages')
    const second = marker.insert(built, 'a', 'New messages')
    // The facts are rebuilt, but the changed turn and the marker row keep their identity.
    expect(second).not.toBe(first)
    expect(second.turns[0]).toBe(first.turns[0])
    expect(second.turns[0]!.rows[0]).toBe(first.turns[0]!.rows[0])
    const relabelled = marker.insert(built, 'a', 'Nouveaux messages')
    expect(relabelled.turns[0]).not.toBe(first.turns[0])
    expect(relabelled.turns[0]!.rows[0]).toMatchObject({ text: 'Nouveaux messages' })
    expect(relabelled.turns[0]!.rows[0]).not.toBe(first.turns[0]!.rows[0])
    // The same facts and boundary after a relabel still reuse the relabelled turn.
    expect(marker.insert(built, 'a', 'Nouveaux messages').turns[0]).toBe(relabelled.turns[0])
  })
})

describe('layout and the visible clock', () => {
  function pending(): NewMessages {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    host.tailValue = { away: true, top: 10, viewport: 5 }
    return marker
  }

  it('does nothing without a boundary, a scrolling host, or a painted marker row', () => {
    const marker = new NewMessages(host)
    marker.layout()
    expect(host.timers.size).toBe(0)

    const noTail = pending()
    host.tailValue = undefined
    noTail.layout()
    expect(host.timers.size).toBe(0)

    host.tailValue = { away: true, top: 10, viewport: 5 }
    host.rowValue = undefined
    noTail.layout()
    expect(host.timers.size).toBe(0)
  })

  it('runs down the visible time while the marker is in view and dismisses it at the deadline', () => {
    const marker = pending()
    host.rowValue = 12
    host.nowValue = 1000
    marker.layout()
    expect(host.timers.size).toBe(1)
    expect([...host.timers.values()][0]!.ms).toBe(NEW_MESSAGES_VISIBLE_MS)
    host.fire()
    expect(marker.pending).toBe(false)
    expect(host.republishes).toBe(1)
    expect(host.scrolls).toEqual([])
  })

  it('pauses below the view and resumes with only the remaining time', () => {
    const marker = pending()
    host.rowValue = 12
    host.nowValue = 1000
    marker.layout()
    const first = host.timers.keys().next().value as number
    host.nowValue = 3000
    host.rowValue = 20
    marker.layout()
    expect(host.cleared).toEqual([first])
    expect(host.timers.size).toBe(0)
    host.nowValue = 4000
    host.rowValue = 12
    marker.layout()
    expect(host.timers.size).toBe(1)
    expect([...host.timers.values()][0]!.ms).toBe(NEW_MESSAGES_VISIBLE_MS - 2000)
  })

  it('does not restart the clock while it is already running or pause one that is not', () => {
    const marker = pending()
    host.rowValue = 12
    host.nowValue = 1000
    marker.layout()
    marker.layout()
    expect(host.timers.size).toBe(1)
    expect(host.cleared).toEqual([])
    host.rowValue = undefined
    marker.layout()
    expect(host.timers.size).toBe(0)
    // A second pause with no clock running is a no-op.
    marker.layout()
    expect(host.cleared).toHaveLength(1)
  })

  it('uses a zero delay when the visible time was already spent', () => {
    const marker = pending()
    host.rowValue = 12
    host.nowValue = 0
    marker.layout()
    const first = host.timers.keys().next().value as number
    host.nowValue = NEW_MESSAGES_VISIBLE_MS + 1
    host.rowValue = 20
    marker.layout()
    expect(host.cleared).toEqual([first])
    host.rowValue = 12
    marker.layout()
    expect([...host.timers.values()][0]!.ms).toBe(0)
  })

  it('dismisses a marker that moved above the view after painting and gives its rows back', async () => {
    const marker = pending()
    host.rowValue = 9
    host.nowValue = 0
    marker.layout()
    expect(marker.pending).toBe(true)
    await Promise.resolve()
    expect(marker.pending).toBe(false)
    expect(host.republishes).toBe(1)
    // The view was away, so the rule's two rows are returned to keep the reader's place.
    expect(host.scrolls).toEqual([-2])
  })

  it('does not give rows back when the reader was at the tail when the marker moved above', async () => {
    const marker = pending()
    host.tailValue = { away: false, top: 10, viewport: 5 }
    host.rowValue = 9
    marker.layout()
    await Promise.resolve()
    expect(marker.pending).toBe(false)
    expect(host.scrolls).toEqual([])
  })

  it('cancels a scheduled dismissal when the marker is reset before the microtask runs', async () => {
    const marker = pending()
    host.rowValue = 9
    marker.layout()
    marker.reset()
    await Promise.resolve()
    expect(marker.pending).toBe(false)
    expect(host.republishes).toBe(0)
  })
})

describe('jump', () => {
  it('brings the marker to the top with a few rows of history above it', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    host.tailValue = { away: true, top: 10, viewport: 5 }
    host.rowValue = 20
    marker.jump()
    expect(host.scrolls).toEqual([20 - NEW_MESSAGES_HISTORY_ROWS])
    expect(host.follows).toBe(0)
  })

  it('follows the tail when the marker is already at or above the history target', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    host.tailValue = { away: true, top: 10, viewport: 5 }
    host.rowValue = 12
    marker.jump()
    expect(host.follows).toBe(1)
    expect(host.scrolls).toEqual([])
  })

  it('follows the tail without a marker, a scrolling host, a row, or while away', () => {
    const marker = new NewMessages(host)
    marker.jump()
    expect(host.follows).toBe(1)

    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    host.rowValue = 20
    marker.jump()
    expect(host.follows).toBe(2)

    host.tailValue = { away: false, top: 10, viewport: 5 }
    marker.jump()
    expect(host.follows).toBe(3)

    host.tailValue = { away: true, top: 10, viewport: 5 }
    host.rowValue = undefined
    marker.jump()
    expect(host.follows).toBe(4)
  })
})

describe('reset', () => {
  it('clears the boundary, clock, seen rows, and marker identity', () => {
    const marker = new NewMessages(host)
    marker.observe(['a'], false)
    marker.observe(['a', 'b'], true)
    host.tailValue = { away: true, top: 10, viewport: 5 }
    host.rowValue = 12
    marker.layout()
    expect(host.timers.size).toBe(1)
    marker.reset()
    expect(marker.pending).toBe(false)
    expect(marker.rowId).toBeUndefined()
    expect(host.timers.size).toBe(0)
    expect(host.cleared).toHaveLength(1)
    // A fresh observation starts from the new tail rather than the old boundary.
    expect(marker.observe(['x', 'y'], false)).toBeUndefined()
    expect(marker.observe(['x', 'y', 'z'], true)).toBe('z')
  })
})
