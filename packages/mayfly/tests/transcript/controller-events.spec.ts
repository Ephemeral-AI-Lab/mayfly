/**
 * What the controller does with the stream's own controls: Enter on a row opens what the row stands for, the copy and
 * open keys read the row under the cursor, focus moves in and out of the stream, the compaction inputs and the clock
 * keep a running row's time, and a search that its view outlives or loses is ended cleanly. A fake slot and screen stand
 * in for the terminal; no clock is read.
 * @module transcript-controller-events
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyListNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { MayflySearchLine, MayflySearchLineOptions } from '../../src/core/search-line.ts'
import { STREAM } from '../../src/components/transcript-view.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TickSource } from '../../src/transcript/tick.ts'
import { TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
import { appendTranscriptNode, createTranscriptModel, TranscriptController, type TranscriptControllerOptions, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })
const answer = (turn: number, text: string): TranscriptEntryModel => ({ id: `assistant:${String(turn)}`, kind: 'transcript-assistant', seq: turn, updatedSeq: turn, turn, step: 2, text, streaming: false })
const thought = (turn: number, text: string): TranscriptEntryModel => ({ id: `thinking:${String(turn)}`, kind: 'transcript-thinking', seq: turn, updatedSeq: turn, turn, step: 1, text, streaming: false, durationMs: 3_000 })
const bash = (id: string, turn: number, done = true): TranscriptEntryModel => ({
  id, kind: 'transcript-tool', seq: turn, updatedSeq: turn, turn, step: 1, callId: id, name: 'bash', family: 'command', activity: 'commands',
  detail: 'ls', arguments: '{}', startedAt: 0, terminal: { command: 'ls', exitCode: 0, output: 'listing' },
  ...(done ? { result: { text: 'listing', isError: false, endedAt: 1_000 } } : {}),
} as unknown as TranscriptEntryModel)

const TURNS = [1, 2].map(turn => ({ turn, startedAt: 0, endedAt: 9_000, outcome: 'completed' })) as never
const modelOf = (entries: TranscriptEntryModel[], streaming = false): TranscriptModel => createTranscriptModel('s', entries, streaming, 0, TURNS)

interface Handlers {
  onEvent: (event: unknown) => void
  onFocus: () => void
  onFocusChange: (focused: boolean) => void
  onLeave: () => void
}

/** The fake slot, search line, and screen; the test moves the cursor and presses the keys. */
function harness(options: Partial<TranscriptControllerOptions> = {}, attach = true) {
  const slot = {
    published: [] as (MayflyUiNode | null)[],
    cursor: undefined as string | undefined,
    focusRows: [] as string[],
    focused: 0,
    released: 0,
    disposed: 0,
    turns: [] as number[],
    handlers: undefined as Handlers | undefined,
  }
  const lease = {
    id: 'transcript.conversation', disposed: false,
    set: (node: MayflyUiNode | null) => { slot.published.push(node) },
    setTurns: (latest: number) => { slot.turns.push(latest) },
    focus: () => { slot.focused += 1 },
    dispose: () => { slot.disposed += 1 },
    release: () => { slot.released += 1 },
    cursor: () => slot.cursor,
    focusRow: (_control: string, item: string) => { slot.focusRows.push(item) },
    setKeys: () => {},
    spotlight: () => {},
    track: () => {},
    trackedRow: () => undefined,
    setMarked: () => {},
  } as unknown as MayflyNodeSlot
  const lines: { options: MayflySearchLineOptions, disposed: boolean, status: string[] }[] = []
  const screen = {
    mountNodeSlot: (_id: string, mount: Parameters<TranscriptScreen['mountNodeSlot']>[1]) => {
      slot.handlers = {
        onEvent: mount.onEvent as never,
        onFocus: () => { mount.onFocus?.() },
        onFocusChange: (focused) => { mount.onFocusChange?.(focused) },
        onLeave: () => { mount.onLeave?.() },
      }
      return lease
    },
    mountSearchLine: (line: MayflySearchLineOptions): MayflySearchLine => {
      const record = { options: line, disposed: false, status: [] as string[] }
      lines.push(record)
      return { get disposed() { return record.disposed }, set: (status: string) => { record.status.push(status) }, edit: () => {}, freeze: () => {}, dispose: () => { record.disposed = true } }
    },
    followContent: vi.fn(),
    watchContentTail: () => () => {},
    contentTail: () => undefined,
    requestRender: vi.fn(),
  } as unknown as TranscriptScreen
  const modes: string[] = []
  const controller = new TranscriptController({ t: interpolateLocaleMessage, queued: () => [], focusMode: mode => { modes.push(mode) }, ...options })
  if (attach) controller.attach(screen)
  const listOf = (): MayflyListNode => {
    const node = slot.published.at(-1) as MayflyUiNode
    return (node.kind === 'stack' ? node.children[0]!.node : node) as MayflyListNode
  }
  const ids = (): string[] => listOf().items.map(item => item.id)
  const accept = (id: string | undefined) => { slot.handlers!.onEvent({ kind: 'selection-accept', controlId: STREAM.list, selectedIds: id === undefined ? [] : [id] }) }
  const activate = (actionId: string, controlId = 'keys') => { slot.handlers!.onEvent({ kind: 'activate', controlId, actionId }) }
  return { controller, slot, lines, modes, screen, listOf, ids, accept, activate }
}

const compactPolicy = (): TranscriptPresentationPolicy => {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ transcriptView: 'compact' })
  return policy
}

describe('building a model by hand', () => {
  it('appends an entry to a model and keeps its turns, generation, and streaming unless told otherwise', () => {
    const base = createTranscriptModel('s', [user(1, 'one')], true, 4, [{ turn: 1, startedAt: 0 }])
    const next = appendTranscriptNode(base, answer(1, 'two'))
    expect(next).toMatchObject({ id: 's', generation: 4, streaming: true, turns: [{ turn: 1, startedAt: 0 }] })
    expect(next.entries.map(entry => entry.kind)).toEqual(['transcript-user', 'transcript-assistant'])
    expect(appendTranscriptNode(base, answer(1, 'two'), false).streaming).toBe(false)
  })
})

describe('a controller with nothing to show', () => {
  it('ignores a refresh until a view is displayed and the screen is attached', () => {
    const { controller, screen, slot } = harness({}, false)
    controller.refresh()
    controller.setView('main', modelOf([user(1, 'hi')]))
    controller.show('main')
    // A displayed view without a screen publishes nowhere and asks for no frame.
    controller.refresh()
    expect(screen.requestRender).not.toHaveBeenCalled()
    controller.attach(screen)
    expect(slot.published).toHaveLength(1)
    const idle = harness({}, true)
    idle.controller.refresh()
    expect(idle.screen.requestRender).toHaveBeenCalledTimes(1)
  })

  it('does not open a search before a view is displayed, or on a controller that is not attached', () => {
    const detached = harness({}, false)
    detached.controller.beginSearch(true)
    const empty = harness()
    empty.controller.beginSearch(true)
    expect(detached.lines).toHaveLength(0)
    expect(empty.lines).toHaveLength(0)
    // Ending a search that was never opened changes nothing.
    empty.controller.endSearch()
    expect(empty.modes).toEqual([])
  })

  it('publishes an empty stream for a displayed view whose source gives no model', () => {
    const { controller, slot } = harness()
    controller.setView('main', () => null)
    controller.show('main')
    expect(slot.published.at(-1)).toBeNull()
    expect(slot.turns.at(-1)).toBe(0)
    // A search over no model finds nothing and says so.
    controller.beginSearch(false)
    controller.refresh()
    expect(slot.published.at(-1)).toBeNull()
  })
})

describe('Enter on a row', () => {
  it('opens a compact turn from its title and sends the cursor to the header that replaces it', () => {
    const { controller, ids, accept, slot } = harness({ presentation: compactPolicy() })
    controller.setView('main', modelOf([user(1, 'run it'), thought(1, 'plan'), bash('b1', 1), answer(1, 'done')]))
    controller.show('main')
    expect(ids()).toContain('process:1')
    accept('process:1')
    expect(ids()).toContain('turn-header:1')
    expect(slot.focusRows.at(-1)).toBe('turn-header:1')
    // Enter on the header folds it back to the title.
    accept('turn-header:1')
    expect(ids()).toContain('process:1')
    expect(slot.focusRows.at(-1)).toBe('process:1')
  })

  it('opens the closing line of a turn like its header', () => {
    const { controller, ids, accept } = harness({ presentation: compactPolicy() })
    controller.setView('main', modelOf([user(1, 'run it'), bash('b1', 1), answer(1, 'done')]))
    controller.show('main')
    accept('turn:1.end')
    expect(ids()).toContain('turn-header:1')
  })

  it('opens a folded prompt and keeps the cursor on its row', () => {
    const { controller, listOf, accept, slot } = harness()
    controller.setView('main', modelOf([user(1, 'a\nb\nc\nd\ne\nf'), answer(1, 'ok')]))
    controller.show('main')
    expect(listOf().items[0]!.wrapMax).toBe(4)
    accept('user:1')
    expect(listOf().items[0]!.wrapMax).toBeUndefined()
    expect(slot.focusRows.at(-1)).toBe('user:1')
    accept('user:1')
    expect(listOf().items[0]!.wrapMax).toBe(4)
  })

  it('opens a whole run from its head, and one call of it alone', () => {
    const { controller, ids, accept, slot } = harness()
    controller.setView('main', modelOf([user(1, 'go'), bash('b1', 1), bash('b2', 1), answer(1, 'ok')]))
    controller.show('main')
    const closed = ids()
    expect(closed).toContain('b1')
    accept('b1')
    const opened = ids()
    expect(opened.length).toBeGreaterThan(closed.length)
    expect(slot.focusRows.at(-1)).toBe('b1')
    // Enter on the head again folds the run.
    accept('b1')
    expect(ids()).toEqual(closed)
    // A call of the run flips alone: the run keeps its shape.
    const call = opened.find(id => id.startsWith('b1.item.'))
    expect(call).toBeDefined()
    accept(call)
    expect(slot.focusRows.at(-1)).toBe(call)
  })

  it('does nothing for an Enter that names no row, a row nothing stands behind, or a conversation that is gone', () => {
    const { controller, slot, accept } = harness()
    controller.setView('main', modelOf([user(1, 'go')]))
    controller.show('main')
    const published = slot.published.length
    accept(undefined)
    accept('no-such-row')
    expect(slot.published).toHaveLength(published)
    // Another control's selection is not the stream's.
    slot.handlers!.onEvent({ kind: 'selection-accept', controlId: 'other', selectedIds: ['user:1'] })
    expect(slot.published).toHaveLength(published)
    controller.dropView('main')
    const dropped = slot.published.length
    accept('user:1')
    expect(slot.published).toHaveLength(dropped)
  })
})

describe('copying and opening the row under the cursor', () => {
  const rows = () => ({ copy: vi.fn(), open: vi.fn(), queued: vi.fn() })

  it('sends its text, its model JSON, or its text to the editor, each to the one action that takes it', () => {
    const actions = rows()
    const { controller, slot, activate } = harness({ rows: actions })
    controller.setView('main', modelOf([user(1, 'hello there'), answer(1, 'an answer')]))
    controller.show('main')
    slot.cursor = 'assistant:1'
    activate(STREAM.copy, STREAM.keys)
    expect(actions.copy).toHaveBeenLastCalledWith('an answer', 'text')
    activate(STREAM.copyRaw, STREAM.keys)
    expect(actions.copy).toHaveBeenLastCalledWith(expect.stringContaining('"transcript-assistant"'), 'raw')
    activate(STREAM.open, STREAM.keys)
    expect(actions.open).toHaveBeenCalledWith('an answer')
    expect(actions.copy).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a cursor, on a row with no text, or when no action is wired', () => {
    const actions = rows()
    const { controller, slot, activate } = harness({ rows: actions })
    controller.setView('main', modelOf([user(1, 'hello'), answer(1, '')]))
    controller.show('main')
    slot.cursor = undefined
    activate(STREAM.copy, STREAM.keys)
    slot.cursor = 'queued:nothing'
    activate(STREAM.copy, STREAM.keys)
    expect(actions.copy).not.toHaveBeenCalled()
    const bare = harness()
    bare.controller.setView('main', modelOf([user(1, 'hello')]))
    bare.controller.show('main')
    bare.slot.cursor = 'user:1'
    expect(() => { bare.activate(STREAM.copy, STREAM.keys) }).not.toThrow()
  })

  it('reads nothing once the conversation is gone, and ignores an event that is not a control', () => {
    const actions = rows()
    const { controller, slot, activate } = harness({ rows: actions })
    controller.setView('main', modelOf([user(1, 'hello')]))
    controller.show('main')
    slot.cursor = 'user:1'
    controller.dropView('main')
    activate(STREAM.copy, STREAM.keys)
    expect(actions.copy).not.toHaveBeenCalled()
    slot.handlers!.onEvent({ kind: 'dismiss' })
    activate('unknown-key')
    expect(actions.copy).not.toHaveBeenCalled()
  })
})

describe('focus moving in and out of the stream', () => {
  it('starts the cursor at the tail when focus moves in, and names the mode as focus changes', () => {
    const { controller, slot, screen, modes } = harness()
    controller.setView('main', modelOf([user(1, 'go'), answer(1, 'ok')]))
    controller.show('main')
    const followed = vi.mocked(screen.followContent).mock.calls.length
    slot.handlers!.onFocus()
    expect(screen.followContent).toHaveBeenCalledTimes(followed + 1)
    slot.handlers!.onFocusChange(true)
    slot.handlers!.onFocusChange(false)
    expect(modes).toEqual(['conversation', 'prompt'])
  })

  it('gives the keys back to the prompt on Esc outside a search', () => {
    const { controller, slot } = harness()
    controller.setView('main', modelOf([user(1, 'go')]))
    controller.show('main')
    slot.handlers!.onLeave()
    expect(slot.released).toBe(1)
  })

  it('leaves the focus mode to the search while its line holds the keys', () => {
    const { controller, slot, modes } = harness()
    controller.setView('main', modelOf([user(1, 'go')]))
    controller.show('main')
    controller.beginSearch(true)
    const announced = modes.length
    slot.handlers!.onFocusChange(false)
    expect(modes).toHaveLength(announced)
  })
})

describe('the inputs a published stream reads', () => {
  it('carries the compaction marks, the context window, the tokens, and the approvals it was given', () => {
    const compaction = { id: 'cmp', kind: 'transcript-compaction', seq: 2, updatedSeq: 2, turn: 1, state: 'ok', trigger: 'auto', startedAt: 0, compactionId: 'c-1', summary: 'kept', shadowedCount: 4 } as unknown as TranscriptEntryModel
    const context = vi.fn(() => ({ marks: [{ id: 'c-1', before: 80_000, after: 20_000, window: 100_000 }], window: 100_000, tokens: 20_000, approvals: [] }) as never)
    const { controller, listOf } = harness({ context })
    controller.setView('main', modelOf([user(1, 'go'), compaction]))
    controller.show('main')
    expect(context).toHaveBeenCalled()
    expect(JSON.stringify(listOf().items)).toContain('context 80% → 20%')
    // Facts that are absent leave the compaction on what it knows: no change line without marks.
    const bare = harness({ context: () => ({}) })
    bare.controller.setView('main', modelOf([user(1, 'go'), compaction]))
    bare.controller.show('main')
    expect(JSON.stringify(bare.listOf().items)).not.toContain('context 80%')
    const none = harness({ context: () => undefined })
    none.controller.setView('main', modelOf([user(1, 'go')]))
    none.controller.show('main')
    expect(none.ids()).toContain('user:1')
  })

  it('republishes at each tick while a call runs, and stops once it settles or the controller is disposed', () => {
    let tick: ((now: number) => void) | undefined
    const off = vi.fn()
    const source: TickSource = { subscribe: (listener) => { tick = listener; return off } }
    const { controller, slot } = harness({ tick: source })
    let model = modelOf([user(1, 'go'), bash('b1', 1, false)], true)
    controller.setView('main', () => model)
    controller.show('main')
    expect(tick).toBeDefined()
    const published = slot.published.length
    tick!(5_000)
    expect(slot.published).toHaveLength(published + 1)
    // A second publish while one runs does not subscribe again.
    controller.republish()
    expect(off).not.toHaveBeenCalled()
    model = modelOf([user(1, 'go'), bash('b1', 1, true)])
    controller.refresh()
    expect(off).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('keeps time by the clock of a running compaction, and runs without a clock', () => {
    const running = { id: 'cmp', kind: 'transcript-compaction', seq: 2, updatedSeq: 2, turn: 1, state: 'running', trigger: 'manual', startedAt: 0 } as unknown as TranscriptEntryModel
    let subscribed = 0
    const { controller } = harness({ tick: { subscribe: () => { subscribed += 1; return () => {} } } })
    controller.setView('main', modelOf([user(1, 'go'), running], true))
    controller.show('main')
    expect(subscribed).toBe(1)
    const untimed = harness()
    untimed.controller.setView('main', modelOf([user(1, 'go'), running], true))
    expect(() => { untimed.controller.show('main') }).not.toThrow()
  })
})

describe('a search over a view that changes', () => {
  const needles = (): TranscriptEntryModel[] => [user(1, 'go'), answer(1, 'a needle'), user(2, 'needle again'), answer(2, 'last needle')]

  it('ignores the line\'s callbacks once the search has ended', () => {
    const { controller, lines, slot } = harness()
    controller.setView('main', modelOf(needles()))
    controller.show('main')
    controller.beginSearch(true)
    const stale = lines[0]!.options
    controller.endSearch()
    const published = slot.published.length
    stale.onChange('needle')
    stale.onAccept()
    expect(slot.published).toHaveLength(published)
    // Repeating a match with no search open does nothing either.
    controller.searchRepeat(true)
    controller.searchStep(1)
    expect(slot.published).toHaveLength(published)
  })

  it('replaces the line of a search opened again, and ends with the cursor on the match header of its turn', () => {
    const { controller, lines, slot, modes } = harness()
    controller.setView('main', modelOf(needles()))
    controller.show('main')
    controller.beginSearch(true)
    controller.beginSearch(false)
    expect(lines[0]!.disposed).toBe(true)
    expect(lines).toHaveLength(2)
    lines[1]!.options.onChange('needle')
    lines[1]!.options.onAccept()
    expect(modes.at(-1)).toBe('search-select')
    slot.cursor = 'assistant:1'
    controller.endSearch()
    expect(modes.at(-1)).toBe('conversation')
    expect(slot.focused).toBeGreaterThan(0)
  })

  it('selects the first or last match when the cursor stands on no row, a row nothing owns, or a turn with no match', () => {
    const forward = harness()
    forward.controller.setView('main', modelOf(needles()))
    forward.controller.show('main')
    forward.controller.beginSearch(true)
    forward.lines[0]!.options.onChange('needle')
    // No cursor: `/` lands on the last match, `?` on the first.
    forward.slot.cursor = undefined
    forward.lines[0]!.options.onAccept()
    expect(forward.slot.focusRows.at(-1)).toBe('assistant:2')
    const backward = harness()
    backward.controller.setView('main', modelOf(needles()))
    backward.controller.show('main')
    backward.controller.beginSearch(false)
    backward.lines[0]!.options.onChange('needle')
    backward.slot.cursor = 'queued:somewhere'
    backward.lines[0]!.options.onAccept()
    expect(backward.slot.focusRows.at(-1)).toBe('assistant:1')
  })

  it('finds the matches again when the conversation changes under a typed pattern, and keeps the walk in range when it shrinks', () => {
    const { controller, lines, slot } = harness()
    let model = modelOf(needles())
    controller.setView('main', () => model)
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    slot.cursor = 'user:1'
    lines[0]!.options.onAccept()
    controller.searchStep(1)
    controller.searchStep(1)
    // The conversation loses its later turn: the walk stays on a match that is left.
    model = modelOf(needles().slice(0, 2))
    controller.refresh()
    controller.searchStep(1)
    expect(slot.focusRows.at(-1)).toBe('assistant:1')
    // And when the model goes away, no match is left to walk.
    model = null as never
    controller.refresh()
    const walked = slot.focusRows.length
    controller.searchStep(1)
    expect(slot.focusRows).toHaveLength(walked)
  })

  it('walks past a match no row draws, in the direction of the step', () => {
    // The step in flight is drawn by its live entries: the durable copy of the same step has a hit but no row.
    const durable = thought(1, 'durable needle')
    const live = { ...thought(1, 'live needle'), id: 'thinking:live', streaming: true }
    const model = { ...modelOf([user(1, 'go'), durable], true), live: { turn: 1, step: 1, entries: [live] } } as TranscriptModel
    const { controller, lines, slot } = harness()
    controller.setView('main', model)
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    slot.cursor = 'user:1'
    lines[0]!.options.onAccept()
    expect(slot.focusRows.at(-1)).toBe('thinking:live')
    expect(lines[0]!.status.at(-1)).toBe('2/2 matches')
  })

  it('says one match in the singular, while typed and once selected', () => {
    const { controller, lines, slot } = harness()
    controller.setView('main', modelOf([user(1, 'one needle only')]))
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    expect(lines[0]!.status.at(-1)).toBe('1 match · Enter to select · Esc to cancel')
    slot.cursor = 'user:1'
    lines[0]!.options.onAccept()
    expect(lines[0]!.status.at(-1)).toBe('1/1 match')
  })

  it('searches the empty result for a pattern typed after the conversation went away, and ends without a match to stand on', () => {
    const { controller, lines, slot, modes } = harness()
    controller.setView('main', modelOf(needles()))
    controller.show('main')
    controller.beginSearch(true)
    controller.dropView('main')
    lines[0]!.options.onChange('needle')
    expect(lines[0]!.status.at(-1)).toBe('No matches · Esc to cancel')
    lines[0]!.options.onAccept()
    expect(slot.focusRows).toEqual([])
    controller.endSearch()
    expect(modes.at(-1)).toBe('conversation')
  })

  it('finds the hits again for a conversation that moved on, keeping the match it stood on by part and occurrence', () => {
    const { controller, lines, slot } = harness()
    let model = modelOf(needles())
    controller.setView('main', () => model)
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    // While typed, a new model keeps the line counting and leaves no match chosen.
    model = modelOf([...needles(), answer(3, 'needle three')])
    controller.refresh()
    expect(lines[0]!.status.at(-1)).toBe('4 matches · Enter to select · Esc to cancel')
    slot.cursor = 'user:2'
    lines[0]!.options.onAccept()
    expect(lines[0]!.status.at(-1)).toBe('2/4 matches')
    // Once selected, the match stays the same one when matches are added before it.
    model = modelOf([user(0, 'needle zero'), ...needles(), answer(3, 'needle three')])
    controller.refresh()
    expect(lines[0]!.status.at(-1)).toBe('3/5 matches')
    // And when the match is gone the walk stays within the matches that are left.
    model = modelOf([user(1, 'go'), answer(1, 'a needle')])
    controller.refresh()
    expect(lines[0]!.status.at(-1)).toBe('1/1 match')
  })

  it('ends a selection whose matches are all gone without moving the cursor to a turn', () => {
    const { controller, lines, slot } = harness()
    let model = modelOf(needles())
    controller.setView('main', () => model)
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    slot.cursor = 'user:1'
    lines[0]!.options.onAccept()
    model = modelOf([user(1, 'go')])
    controller.refresh()
    slot.cursor = 'user:1'
    controller.endSearch()
    expect(slot.focusRows.at(-1)).toBe('user:1')
  })

  it('keeps the cursor where it stands when a search hands the keys back', () => {
    const { controller, lines, slot, screen } = harness()
    controller.setView('main', modelOf(needles()))
    controller.show('main')
    controller.beginSearch(true)
    lines[0]!.options.onChange('needle')
    slot.cursor = 'user:1'
    lines[0]!.options.onAccept()
    const followed = vi.mocked(screen.followContent).mock.calls.length
    // The focus the accepted search asks for does not send the cursor back to the tail.
    slot.handlers!.onFocus()
    expect(screen.followContent).toHaveBeenCalledTimes(followed)
  })
})

describe('a change of policy or locale', () => {
  it('publishes every row again and asks for a full paint', () => {
    const policy = new TranscriptPresentationPolicy()
    const { controller, screen, ids } = harness({ presentation: policy })
    controller.setView('main', modelOf([user(1, 'run it'), thought(1, 'plan'), bash('b1', 1), answer(1, 'done')]))
    controller.show('main')
    expect(ids()).not.toContain('process:1')
    policy.apply({ transcriptView: 'compact' })
    controller.refreshPresentationPolicy()
    expect(screen.requestRender).toHaveBeenLastCalledWith(true)
    expect(ids()).toContain('process:1')
    expect(controller.presentationPolicy().mode).toBe('compact')
    vi.mocked(screen.requestRender).mockClear()
    controller.refreshLocale()
    expect(screen.requestRender).toHaveBeenCalledWith(true)
  })
})

describe('showing views', () => {
  it('leaves a displayed view alone when it is shown again, and when another view is dropped', () => {
    const { controller, slot, screen } = harness()
    controller.setView('main', modelOf([user(1, 'go')]))
    controller.setView('side', modelOf([user(1, 'side')]))
    controller.show('main')
    const published = slot.published.length
    controller.show('main')
    controller.dropView('side')
    controller.dropView('never-set')
    expect(slot.published).toHaveLength(published)
    expect(screen.followContent).not.toHaveBeenCalled()
  })

  it('passes the byte references of the images to the stream', () => {
    const imageRefs = new Map<string, { readonly attachmentId: string, readonly mediaType: string }>()
    const image = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
    const { controller } = harness({ imageRefs })
    controller.setView('main', modelOf([{ ...user(1, 'look'), images: [image] } as never]))
    controller.show('main')
    expect(imageRefs.get('att-1')).toEqual({ attachmentId: 'att-1', mediaType: 'image/png' })
  })
})

describe('the controller\'s lifetime', () => {
  it('drops the displayed search with its view and releases the slot when it is disposed or attached again', () => {
    const { controller, slot, lines, screen } = harness()
    controller.setView('main', modelOf([user(1, 'go')]))
    controller.show('main')
    controller.beginSearch(true)
    controller.attach(screen)
    expect(lines[0]!.disposed).toBe(true)
    expect(slot.disposed).toBe(1)
    controller.dispose()
    expect(slot.disposed).toBe(2)
    // A disposed controller holds no view: showing nothing publishes nothing.
    const published = slot.published.length
    controller.republish()
    expect(slot.published).toHaveLength(published)
  })
})
