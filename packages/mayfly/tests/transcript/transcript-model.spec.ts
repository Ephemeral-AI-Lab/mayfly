/**
 * The conversation controller behind the transcript node slot: publishing through the window, the new-messages marker's
 * host calls, focus reporting, search corpus reuse, and the controller's presentation rewrite. A fake screen stands in for
 * the content scroll and the slot.
 * @module @ephemeral-ai/mayfly/tests/transcript/transcript-model
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyListNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { MayflySearchLine, MayflySearchLineOptions } from '../../src/core/search-line.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { STREAM } from '../../src/components/transcript-view.ts'
import { NEW_MESSAGES_HISTORY_ROWS, NEW_MESSAGES_VISIBLE_MS } from '../../src/transcript/new-messages.ts'
import { NEW_MESSAGES_ROWS } from '../../src/components/transcript-view.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION } from '../../src/transcript/presentation-policy.ts'
import { appendTranscriptNode, createTranscriptModel, PUBLISH_INTERVAL_MS, TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })
const answer = (turn: number, text: string): TranscriptEntryModel => ({ id: `assistant:${String(turn)}`, kind: 'transcript-assistant', seq: turn, updatedSeq: turn, turn, step: 2, text, streaming: false })

function fakeClock() {
  let now = 1_000
  const timers = new Map<number, { at: number, callback: () => void }>()
  let next = 0
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void, ms: number) => { timers.set(++next, { at: now + ms, callback }); return next },
      clearTimeout: (handle: unknown) => { timers.delete(handle as number) },
    },
    advance: (ms: number): void => {
      now += ms
      for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() }
    },
    timers,
  }
}

/** The slot, the content scroll, and the search line the controller drives. */
function bench(entries: TranscriptEntryModel[] = [user(1, 'one')], queued: { id: string, text: string, lane: 'turn' | 'step' }[] = [], useClock = true) {
  const state = {
    published: [] as (MayflyUiNode | null)[],
    marked: [] as boolean[],
    tracked: [] as (string | undefined)[],
    turned: [] as number[],
    cursor: undefined as string | undefined,
    cursorTargets: [] as string[],
    focusRows: [] as string[],
    keys: [] as Record<string, string>[],
    spotlit: [] as boolean[],
    released: 0,
    focused: 0,
    handlers: undefined as undefined | { onEvent: (event: unknown) => void, onLeave: () => void, onFocus: () => void },
    onFocusChange: undefined as undefined | ((focused: boolean) => void),
    onMove: undefined as undefined | ((itemId: string | undefined) => void),
  }
  let trackedRow: number | undefined
  const lease: MayflyNodeSlot = {
    id: 'transcript.conversation', disposed: false,
    set: (node: MayflyUiNode | null) => { state.published.push(node) },
    setTurns: (turn: number) => { state.turned.push(turn) },
    setMarked: (marked: boolean) => { state.marked.push(marked) },
    track: (_control: string, itemId: string | undefined) => { state.tracked.push(itemId) },
    focus: () => { state.focused += 1 },
    release: () => { state.released += 1 },
    cursor: () => state.cursor,
    focusRow: (_control: string, itemId: string) => { state.cursorTargets.push(itemId) },
    setKeys: (keys: Record<string, string>) => { state.keys.push(keys) },
    spotlight: (on: boolean) => { state.spotlit.push(on) },
    trackedRow: () => trackedRow,
    cursorRow: () => undefined,
    dispose: () => {},
  } as unknown as MayflyNodeSlot
  const tail = { away: false, top: 0, viewport: 10 }
  let layout: (() => void) | undefined
  const lines: { options: MayflySearchLineOptions, status: string[], disposed: boolean, frozen: boolean }[] = []
  const screen = {
    mountNodeSlot: (_id: string, options: Parameters<TranscriptScreen['mountNodeSlot']>[1]) => {
      state.handlers = { onEvent: options.onEvent as never, onLeave: () => { options.onLeave?.() }, onFocus: () => { options.onFocus?.() } }
      state.onFocusChange = options.onFocusChange as never
      state.onMove = (options.cursor as { onMove?: (itemId: string | undefined) => void } | undefined)?.onMove
      return lease
    },
    mountSearchLine: (options: MayflySearchLineOptions): MayflySearchLine => {
      const record = { options, status: [] as string[], disposed: false, frozen: false }
      lines.push(record)
      return {
        get disposed() { return record.disposed },
        set: (status: string) => { record.status.push(status) },
        edit: () => {},
        freeze: () => { record.frozen = true },
        dispose: () => { record.disposed = true },
      }
    },
    followContent: vi.fn(),
    scrollContent: vi.fn(),
    scrollContentTo: vi.fn(),
    requestRender: vi.fn(),
    watchContentTail: (callback: () => void) => { layout = callback; return () => { layout = undefined } },
    contentTail: () => tail,
  } as unknown as TranscriptScreen
  const focusRows: (string | undefined)[] = []
  let model = createTranscriptModel('a', entries)
  const { clock, advance, timers } = fakeClock()
  const controller = new TranscriptController({
    t: interpolateLocaleMessage, queued: () => queued, ...(useClock ? { clock } : {}), focusRow: row => { focusRows.push(row) },
    rows: { copy: vi.fn(), open: vi.fn(), queued: vi.fn() },
  })
  controller.setView('main', () => model)
  controller.show('main')
  controller.attach(screen)
  const press = (actionId: string): void => { state.handlers!.onEvent({ kind: 'activate', controlId: 'keys', actionId }) }
  const type = (pattern: string): void => { lines.at(-1)!.options.onChange(pattern) }
  const accept = (): void => { lines.at(-1)!.options.onAccept() }
  const listOf = (): MayflyListNode => {
    const node = state.published.at(-1) as MayflyUiNode
    return (node.kind === 'stack' ? node.children[0]!.node : node) as MayflyListNode
  }
  return {
    controller, state, screen, tail, lines, timers, advance, press, type, accept, listOf, focusRows,
    setModel: (next: TranscriptEntryModel[]) => { model = createTranscriptModel('a', next) },
    setModelObject: (next: TranscriptModel) => { model = next },
    getModel: () => model,
    setRow: (row: number | undefined) => { trackedRow = row },
    layout: () => { layout?.() },
  }
}

describe('the new-messages marker on the content scroll', () => {
  it('marks rows that arrive while the reader is away and brings the marker to the top', () => {
    const b = bench([user(1, 'one')])
    b.tail.away = true
    b.setModel([user(1, 'one'), user(2, 'two')])
    b.controller.refresh()
    b.advance(PUBLISH_INTERVAL_MS)
    expect(b.state.marked.at(-1)).toBe(true)
    expect(JSON.stringify(b.state.published.at(-1))).toContain('new-messages')
    expect(b.state.tracked.at(-1)).toBe('new-messages')
    // The marker is on the 20th row: Ctrl+↓ takes it to the top with history above it.
    b.setRow(20)
    b.controller.jumpNew()
    expect(b.screen.scrollContentTo).toHaveBeenCalledWith(20 - NEW_MESSAGES_HISTORY_ROWS)
    // With the target already at the top there is nowhere to scroll: follow the tail instead.
    b.tail.top = 18
    b.controller.jumpNew()
    expect(b.screen.followContent).toHaveBeenCalled()
  })

  it('runs the marker\'s visible time, pauses it off screen, and gives its rows back when passed', async () => {
    const b = bench([user(1, 'one')])
    b.tail.away = true
    b.setModel([user(1, 'one'), user(2, 'two')])
    b.controller.refresh()
    b.advance(PUBLISH_INTERVAL_MS)
    // In the window: the marker starts its five seconds.
    b.setRow(20)
    b.tail.top = 15
    b.layout()
    expect(b.timers.size).toBe(1)
    // Below the window: it pauses and clears its timer.
    b.tail.viewport = 5
    b.layout()
    expect(b.timers.size).toBe(0)
    // Back in view: a new timer for what is left, which dismisses the marker and republishes.
    b.tail.viewport = 10
    b.layout()
    b.advance(NEW_MESSAGES_VISIBLE_MS)
    expect(b.state.marked.at(-1)).toBe(false)
    b.advance(PUBLISH_INTERVAL_MS)
    expect(JSON.stringify(b.state.published.at(-1))).not.toContain('new-messages')
    // A marker above the window was passed: it goes and gives its three rows back.
    b.tail.away = true
    b.setModel([user(1, 'one'), user(2, 'two'), user(3, 'three')])
    b.controller.refresh()
    b.advance(PUBLISH_INTERVAL_MS)
    b.setRow(4)
    b.tail.top = 9
    b.layout()
    await Promise.resolve()
    expect(b.screen.scrollContent).toHaveBeenCalledWith('up', NEW_MESSAGES_ROWS)
    b.advance(PUBLISH_INTERVAL_MS)
    expect(b.state.marked.at(-1)).toBe(false)
    b.controller.dispose()
  })
})

describe('focus and search on the stream', () => {
  it('reports the row under a focused cursor, and releases the keys outside a search', () => {
    const b = bench([user(1, 'one')], [{ id: 'm1', text: 'later', lane: 'turn' }])
    b.state.cursor = 'queued.m1'
    b.state.onFocusChange!(true)
    b.controller.republish()
    b.advance(PUBLISH_INTERVAL_MS)
    expect(b.focusRows.at(-1)).toBe('queued')
    b.state.cursor = undefined
    b.state.onFocusChange!(false)
    b.controller.republish()
    b.advance(PUBLISH_INTERVAL_MS)
    expect(b.focusRows.at(-1)).toBeUndefined()
    // Esc outside a search gives the keyboard back to the prompt.
    b.state.handlers!.onLeave()
    expect(b.state.released).toBe(1)
    b.state.handlers!.onFocus()
    expect(b.screen.followContent).toHaveBeenCalled()
  })

  it('reuses the hits of an equal search corpus when a fresh model carries the same entries', () => {
    const entries = [user(1, 'go'), answer(1, 'a needle here'), user(2, 'needle again')]
    const b = bench(entries)
    b.press(STREAM.findDown)
    b.type('needle')
    expect(b.lines[0]!.status.at(-1)).toBe('2 matches · Enter to select · Esc to cancel')
    const before = b.getModel()
    // A new model object over the same durable entries is the same search corpus: no re-search is needed.
    b.setModelObject({ ...before })
    b.controller.refresh()
    b.advance(PUBLISH_INTERVAL_MS)
    expect(b.lines[0]!.status.at(-1)).toBe('2 matches · Enter to select · Esc to cancel')
    b.controller.dispose()
  })

  it('has no marker to jump to without a displayed view, and lays out harmlessly with none', () => {
    const b = bench()
    b.controller.show(undefined)
    b.controller.jumpNew()
    expect(b.screen.followContent).toHaveBeenCalledTimes(1)
    b.layout()
    expect(b.state.published.at(-1)).toBeNull()
    b.controller.dispose()
  })
})

describe('controller models and presentation', () => {
  it('builds and appends models without folding events, and exposes the default policy', () => {
    const first = createTranscriptModel('a', [user(1, 'one')], false, 3, [{ turn: 1, startedAt: 0 }])
    expect(first).toMatchObject({ id: 'a', generation: 3, streaming: false, turns: [{ turn: 1, startedAt: 0 }] })
    const appended = appendTranscriptNode(first, user(2, 'two'), true)
    expect(appended).toMatchObject({ id: 'a', generation: 3, streaming: true })
    expect(appended.entries).toHaveLength(2)
    expect(appended.turns).toEqual(first.turns)
    const b = bench()
    expect(b.controller.presentationPolicy()).toBe(DEFAULT_TRANSCRIPT_PRESENTATION)
    b.controller.refreshPresentationPolicy()
    b.controller.refreshLocale()
    expect(b.screen.requestRender).toHaveBeenCalledWith(true)
    b.controller.dispose()
  })
})

describe('a search that must mount the hit it finds', () => {
  it('publishes the visited turn once and lands on the row it then draws', () => {
    // Twenty turns keep only the newest fifteen mounted: a hit in an early turn needs the publish to be drawn at all.
    const entries = Array.from({ length: 20 }, (_, index) => user(index + 1, index === 1 ? 'old needle' : `turn ${String(index + 1)}`))
    const b = bench(entries)
    b.press(STREAM.findDown)
    b.type('needle')
    expect(b.lines[0]!.status.at(-1)).toBe('1 match · Enter to select · Esc to cancel')
    const before = b.state.published.length
    b.accept()
    expect(b.state.published.length - before).toBe(2)
    expect(b.state.cursorTargets.at(-1)).toBe('user:2')
    expect(b.lines[0]!.status.at(-1)).toBe('1/1 match')
    b.controller.dispose()
  })
})

describe('the marker without a test clock', () => {
  it('uses the platform timers and clears a paused marker', () => {
    vi.useFakeTimers()
    try {
      const b = bench([user(1, 'one')], [], false)
      b.tail.away = true
      b.setModel([user(1, 'one'), user(2, 'two')])
      b.controller.refresh()
      vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
      expect(b.state.marked.at(-1)).toBe(true)
      // The marker is in view and starts a platform timer, then leaves the view and clears it.
      b.setRow(20)
      b.tail.top = 15
      b.layout()
      b.tail.top = 0
      b.layout()
      // The paused timer was cleared: letting its time pass does not dismiss the marker.
      vi.advanceTimersByTime(NEW_MESSAGES_VISIBLE_MS * 2)
      expect(b.state.marked.at(-1)).toBe(true)
      b.controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
