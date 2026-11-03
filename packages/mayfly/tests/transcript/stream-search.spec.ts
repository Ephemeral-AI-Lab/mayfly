/** The stream's keys as the controller takes them: `/` and `?` open a search that only highlights while it is typed, `Enter` lands on a match, `n`/`N` and the arrows walk the matches with wrap, and `Esc` ends the search with the cursor where it stood. A fake screen stands in for the slot and the line; no clock is read. */
import { describe, expect, it, vi } from 'vitest'
import type { MayflyListNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { MayflySearchLine, MayflySearchLineOptions } from '../../src/core/search-line.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { STREAM } from '../../src/components/transcript-view.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { createTranscriptModel, TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })
const answer = (turn: number, text: string): TranscriptEntryModel => ({ id: `assistant:${String(turn)}`, kind: 'transcript-assistant', seq: turn, updatedSeq: turn, turn, step: 2, text, streaming: false })
const thought = (id: string, turn: number, text: string, streaming = false): TranscriptEntryModel => ({ id, kind: 'transcript-thinking', seq: turn, updatedSeq: turn, turn, step: 1, text, streaming, durationMs: 3_000 })

/** The lifecycle of three completed turns: a turn with a run draws its header only when its lifecycle is known. */
const TURNS = [1, 2, 3].map(turn => ({ turn, startedAt: 0, endedAt: 9_000, outcome: 'completed' })) as never
/** A model of the given entries, with the lifecycle of the three turns. */
const modelOf = (list: TranscriptEntryModel[]) => createTranscriptModel('s', list, false, 0, TURNS)

/** A bash call; two of them in one turn make a run, and the turn draws a header row the cursor can stand on. */
const bash = (id: string, turn: number): TranscriptEntryModel => ({
  id, kind: 'transcript-tool', seq: turn, updatedSeq: turn, turn, step: 1, callId: id, name: 'bash', family: 'command', activity: 'commands',
  detail: 'ls', arguments: '{}', startedAt: 0, terminal: { command: 'ls', exitCode: 0, output: 'listing' }, result: { text: 'listing', isError: false, endedAt: 1_000 },
} as unknown as TranscriptEntryModel)

/** Three turns; the needle sits in `assistant:1`, `user:2`, and `assistant:2`, so the parts order is user:1, assistant:1, user:2, tool:2a, tool:2b, assistant:2, user:3. */
const entries = (): TranscriptEntryModel[] => [
  user(1, 'go'), answer(1, 'a needle here'), user(2, 'needle again'), bash('tool:2a', 2), bash('tool:2b', 2), answer(2, 'needle and more'), user(3, 'plain'),
]

/** The fake slot and line the controller drives: it records what the controller asked and lets the test move the cursor. */
function fakeScreen(options: { queued?: { id: string, text: string, lane: 'turn' | 'step' }[], rows?: Record<string, ReturnType<typeof vi.fn>>, focusRow?: (row: string | undefined) => void } = {}) {
  const slot = {
    published: [] as (MayflyUiNode | null)[],
    cursor: undefined as string | undefined,
    focusRows: [] as string[],
    keys: [] as Record<string, string>[],
    spotlit: [] as boolean[],
    focused: 0,
    released: 0,
    handlers: undefined as undefined | { onEvent: (event: unknown) => void, onLeave: () => void, onFocus: () => void },
    onMove: undefined as undefined | ((itemId: string | undefined) => void),
    onFocusChange: undefined as undefined | ((focused: boolean) => void),
  }
  const lease: MayflyNodeSlot = {
    id: 'transcript.conversation', disposed: false,
    set: (node: MayflyUiNode | null) => { slot.published.push(node) },
    setTurns: () => {}, track: () => {}, setMarked: () => {},
    focus: () => { slot.focused += 1 },
    dispose: () => {},
    release: () => { slot.released += 1 },
    cursor: () => slot.cursor,
    focusRow: (_control: string, item: string) => { slot.focusRows.push(item) },
    setKeys: (keys: Record<string, string>) => { slot.keys.push(keys) },
    spotlight: (on: boolean) => { slot.spotlit.push(on) },
  } as unknown as MayflyNodeSlot
  const lines: { options: MayflySearchLineOptions, status: string[], disposed: boolean, frozen: boolean }[] = []
  const screen = {
    mountNodeSlot: (_id: string, options: Parameters<TranscriptScreen['mountNodeSlot']>[1]) => {
      slot.handlers = { onEvent: options.onEvent as never, onLeave: () => { options.onLeave?.() }, onFocus: () => { options.onFocus?.() } }
      slot.onMove = (options.cursor as { onMove?: (itemId: string | undefined) => void } | undefined)?.onMove
      slot.onFocusChange = options.onFocusChange as never
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
    requestRender: vi.fn(),
    watchContentTail: () => () => {},
    contentTail: () => undefined,
    scrollContentTo: vi.fn(),
  } as unknown as TranscriptScreen
  const focusMode: string[] = []
  const controller = new TranscriptController({ t: interpolateLocaleMessage, queued: () => options.queued ?? [], focusMode: mode => { focusMode.push(mode) }, rows: options.rows as never, focusRow: options.focusRow as never })
  controller.setView('main', modelOf(entries()))
  controller.show('main')
  controller.attach(screen)
  const press = (actionId: string) => { slot.handlers!.onEvent({ kind: 'activate', controlId: 'keys', actionId }) }
  const type = (pattern: string) => { lines.at(-1)!.options.onChange(pattern) }
  const accept = () => { lines.at(-1)!.options.onAccept() }
  const abandon = () => { lines.at(-1)!.options.onAbandon() }
  const listOf = (): MayflyListNode => {
    const node = slot.published.at(-1) as MayflyUiNode
    return (node.kind === 'stack' ? node.children[0]!.node : node) as MayflyListNode
  }
  return { controller, slot, lines, focusMode, press, type, accept, abandon, listOf, last: () => slot.focusRows.at(-1) }
}

describe('opening and typing a search', () => {
  it('opens a line with its prefix, holds the stream\'s own keys, and says what to type', () => {
    const s = fakeScreen()
    s.press(STREAM.findDown)
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0]!.options.prefix).toBe('/')
    expect(s.slot.spotlit.at(-1)).toBe(true)
    expect(s.slot.keys.at(-1)).toEqual({ 'ctrl+c': STREAM.copyRaw, '/': STREAM.findDown, '?': STREAM.findUp, d: 'queued-cancel', e: 'queued-edit', s: 'queued-steer', u: 'queued-undo' })
    expect(s.focusMode.at(-1)).toBe('search')
    expect(s.lines[0]!.status.at(-1)).toBe('Type a regular expression · Enter to select · Esc to cancel')
  })

  it('uses the question mark for a backward search', () => {
    const s = fakeScreen()
    s.press(STREAM.findUp)
    expect(s.lines[0]!.options.prefix).toBe('?')
  })

  it('only highlights and counts while typed: the cursor does not move, and the matches are marked on the list', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    const focusesBefore = s.slot.focusRows.length
    s.type('needle')
    expect(s.lines[0]!.status.at(-1)).toBe('3 matches · Enter to select · Esc to cancel')
    expect(s.slot.focusRows).toHaveLength(focusesBefore)
    expect(s.listOf().highlight).toEqual({ pattern: 'needle', caseSensitive: false })
    s.type('needle zzz')
    expect(s.lines[0]!.status.at(-1)).toBe('No matches · Esc to cancel')
    s.type('(')
    expect(s.lines[0]!.status.at(-1)).toBe('Invalid regular expression · Esc to cancel')
    expect(s.listOf().highlight).toBeUndefined()
  })

  it('reads a capital in the pattern as an exact match in the highlight', () => {
    const s = fakeScreen()
    s.press(STREAM.findDown)
    s.type('Needle')
    expect(s.listOf().highlight).toEqual({ pattern: 'Needle', caseSensitive: true })
    expect(s.lines[0]!.status.at(-1)).toBe('No matches · Esc to cancel')
  })
})

describe('accepting a search', () => {
  it('lands on the first match at or past the cursor row, and selects with the search keys', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('assistant:1')
    expect(s.lines[0]!.frozen).toBe(true)
    expect(s.slot.keys.at(-1)).toMatchObject({ up: STREAM.matchPrev, down: STREAM.matchNext, n: STREAM.matchAgain, 'shift+n': STREAM.matchBack })
    expect(s.lines[0]!.status.at(-1)).toBe('1/3 matches')
    expect(s.focusMode.at(-1)).toBe('search-select')
  })

  it('counts the row the cursor stands on: a match on it is the landing', () => {
    const s = fakeScreen()
    s.slot.cursor = 'assistant:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('assistant:1')
  })

  it('lands a backward search on the last match at or before the cursor row', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:2'
    s.press(STREAM.findUp)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('user:2')
    expect(s.lines[0]!.status.at(-1)).toBe('2/3 matches')
  })

  it('lands on the first match of a turn when the cursor stands on its header', () => {
    const s = fakeScreen()
    s.slot.cursor = 'turn-header:2'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('user:2')
  })

  it('wraps to the first match when no match lies past the cursor, and to the last when none lies before it', () => {
    const forward = fakeScreen()
    forward.slot.cursor = 'user:3'
    forward.press(STREAM.findDown)
    forward.type('needle')
    forward.accept()
    expect(forward.last()).toBe('assistant:1')
    const backward = fakeScreen()
    backward.slot.cursor = 'user:1'
    backward.press(STREAM.findUp)
    backward.type('needle')
    backward.accept()
    expect(backward.last()).toBe('assistant:2')
  })

  it('accepts nothing when the pattern matches nothing: the line stays and the keys stay with it', () => {
    const s = fakeScreen()
    s.press(STREAM.findDown)
    s.type('zzz')
    const before = s.slot.focusRows.length
    s.accept()
    expect(s.slot.focusRows).toHaveLength(before)
    expect(s.lines[0]!.frozen).toBe(false)
  })
})

describe('walking the matches', () => {
  it('moves with the arrows and n/N, wrapping at both ends, and keeps the cursor on a match row', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('assistant:1')
    s.press(STREAM.matchNext)
    expect(s.last()).toBe('user:2')
    s.press(STREAM.matchAgain)
    expect(s.last()).toBe('assistant:2')
    // The next past the last wraps to the first.
    s.press(STREAM.matchNext)
    expect(s.last()).toBe('assistant:1')
    // The previous before the first wraps to the last.
    s.press(STREAM.matchPrev)
    expect(s.last()).toBe('assistant:2')
    // `N` goes back against the direction the search was made in.
    s.press(STREAM.matchBack)
    expect(s.last()).toBe('user:2')
    expect(s.lines[0]!.status.at(-1)).toBe('2/3 matches')
  })

  it('reverses n and N for a backward search', () => {
    const s = fakeScreen()
    s.slot.cursor = 'assistant:2'
    s.press(STREAM.findUp)
    s.type('needle')
    s.accept()
    expect(s.last()).toBe('assistant:2')
    s.press(STREAM.matchAgain)
    expect(s.last()).toBe('user:2')
    s.press(STREAM.matchBack)
    expect(s.last()).toBe('assistant:2')
  })

  it('keeps the highlight on the current match of the list: its occurrence number, counted from zero', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    expect(s.listOf().highlight).toMatchObject({ pattern: 'needle', current: 0 })
    s.press(STREAM.matchNext)
    expect(s.listOf().highlight).toMatchObject({ current: 0 })
  })

  it('ignores the walk keys while the pattern is still being typed', () => {
    const s = fakeScreen()
    s.press(STREAM.findDown)
    s.type('needle')
    s.press(STREAM.matchNext)
    s.press(STREAM.matchAgain)
    expect(s.lines[0]!.status.at(-1)).toBe('3 matches · Enter to select · Esc to cancel')
  })

  it('lands on a drawn hit with one extra publish', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    const before = s.slot.published.length
    s.accept()
    // The row was already drawn: one publish mounts the visit and sends the cursor, with no duplicate at the end.
    expect(s.slot.published.length - before).toBe(1)
    expect(s.last()).toBe('assistant:1')
  })

  it('walks past a match no row draws and ends on the same drawn hit', () => {
    // The durable copy of the live step is searched but not drawn: one match is skipped on the way to the live row.
    const model = { ...modelOf([user(1, 'go'), thought('thinking:durable', 1, 'durable needle')]), live: { turn: 1, step: 1, entries: [thought('thinking:live', 1, 'live needle', true)] } } as TranscriptModel
    const s = fakeScreen()
    s.controller.setView('main', model)
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    const before = s.slot.published.length
    s.accept()
    expect(s.last()).toBe('thinking:live')
    expect(s.lines[0]!.status.at(-1)).toBe('2/2 matches')
    // One publish to mount the skipped turn, one to send the cursor: no empty publish closes the walk.
    expect(s.slot.published.length - before).toBe(2)
  })
})

describe('ending a search', () => {
  it('Esc while typing abandons the line and leaves the cursor where it was', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:2'
    s.press(STREAM.findDown)
    s.type('needle')
    const before = s.slot.focusRows.length
    s.abandon()
    expect(s.lines[0]!.disposed).toBe(true)
    expect(s.slot.spotlit.at(-1)).toBe(false)
    expect(s.slot.keys.at(-1)).toEqual({ 'ctrl+c': STREAM.copyRaw, '/': STREAM.findDown, '?': STREAM.findUp, d: 'queued-cancel', e: 'queued-edit', s: 'queued-steer', u: 'queued-undo' })
    expect(s.slot.focusRows).toHaveLength(before)
    expect(s.focusMode.at(-1)).toBe('conversation')
    expect(s.listOf().highlight).toBeUndefined()
  })

  it('Esc or Alt+Down in selection ends the search and keeps the cursor on the row it stood on', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    s.press(STREAM.matchNext)
    expect(s.last()).toBe('user:2')
    s.slot.cursor = 'user:2'
    s.slot.handlers!.onLeave()
    expect(s.lines[0]!.disposed).toBe(true)
    expect(s.slot.released).toBe(0)
    expect(s.focusMode.at(-1)).toBe('conversation')
    expect(s.listOf().highlight).toBeUndefined()
    // The row the cursor stood on is sent back to, and the header of its turn is named after it.
    expect(s.slot.focusRows.at(-1)).toBe('user:2')
  })

  it('a second Esc, outside the search, gives the keys back to the prompt', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    s.slot.handlers!.onLeave()
    s.slot.handlers!.onLeave()
    expect(s.slot.released).toBe(1)
  })

  it('a session switch closes the line without handing the keys back, and the next search starts fresh', () => {
    const s = fakeScreen()
    s.press(STREAM.findDown)
    s.type('needle')
    s.controller.show(undefined)
    expect(s.lines[0]!.disposed).toBe(true)
    expect(s.focusMode.at(-1)).toBe('prompt')
    s.controller.setView('other', createTranscriptModel('o', [user(1, 'x')]))
    s.controller.show('other')
    expect(s.listOf().highlight).toBeUndefined()
  })

  it('a conversation that moves on while the search is open is searched again, and the current match is kept by its part and occurrence', () => {
    const s = fakeScreen()
    s.slot.cursor = 'user:1'
    s.press(STREAM.findDown)
    s.type('needle')
    s.accept()
    s.press(STREAM.matchNext)
    expect(s.last()).toBe('user:2')
    s.controller.setView('main', modelOf([...entries(), answer(3, 'a needle too')]))
    s.controller.refresh()
    expect(s.lines[0]!.status.at(-1)).toBe('2/4 matches')
  })
})

describe('the keys of a queued message under the cursor', () => {
  const queuedMessages = [{ id: 'm1', text: 'later', lane: 'turn' as const }, { id: 'm2', text: 'steer now', lane: 'step' as const }]
  const rig = () => {
    const rows = { queued: vi.fn() }
    const focusRow = vi.fn()
    const s = fakeScreen({ queued: queuedMessages, rows, focusRow })
    return { ...s, rows, focusRow }
  }

  it('edits the queued message under the cursor, and gives the keyboard back to the prompt', () => {
    const s = rig()
    s.slot.cursor = 'queued.m1'
    s.press(STREAM.queuedEdit)
    expect(s.rows.queued).toHaveBeenCalledWith('edit', 'm1')
    expect(s.slot.released).toBe(1)
  })

  it('steers a message of the next turn, but not one already steering', () => {
    const s = rig()
    s.slot.cursor = 'queued.m2'
    s.press(STREAM.queuedSteer)
    expect(s.rows.queued).not.toHaveBeenCalled()
    s.slot.cursor = 'queued.m1'
    s.press(STREAM.queuedSteer)
    expect(s.rows.queued).toHaveBeenCalledWith('steer', 'm1')
    expect(s.slot.released).toBe(0)
  })

  it('cancels a message under the cursor, and undoes the last cancelled one without a cursor', () => {
    const s = rig()
    s.slot.cursor = 'queued.m2'
    s.press(STREAM.queuedCancel)
    expect(s.rows.queued).toHaveBeenCalledWith('cancel', 'm2')
    s.slot.cursor = undefined
    s.press(STREAM.queuedEdit)
    expect(s.rows.queued).toHaveBeenCalledTimes(1)
    s.press(STREAM.queuedUndo)
    expect(s.rows.queued).toHaveBeenLastCalledWith('undo', undefined)
  })

  it('names the row type under the cursor to the notification row, and clears it off a message', () => {
    const s = rig()
    s.slot.cursor = 'queued.m1'
    s.slot.onFocusChange!(true)
    s.slot.onMove!('queued.m1')
    expect(s.focusRow).toHaveBeenLastCalledWith('queued')
    s.slot.onMove!('queued.m2')
    expect(s.focusRow).toHaveBeenLastCalledWith('steering')
    s.slot.onMove!('user:1')
    expect(s.focusRow).toHaveBeenLastCalledWith(undefined)
    s.slot.onMove!('queued.m1')
    s.slot.onFocusChange!(false)
    expect(s.focusRow).toHaveBeenLastCalledWith(undefined)
  })

  it('opens a queued message to its whole text on Enter, as a selection of its own row', () => {
    const s = rig()
    const published = s.slot.published.length
    s.slot.handlers!.onEvent({ kind: 'selection-accept', controlId: STREAM.list, selectedIds: ['queued.m1'] })
    expect(s.slot.published.length).toBeGreaterThan(published)
  })
})
