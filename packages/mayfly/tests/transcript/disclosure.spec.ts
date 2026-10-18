/** The reader's openings: which turns Ctrl+O and Enter open against the level, how rows, runs, and calls flip, and what each level draws by default. */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, type TranscriptViewMode } from '../../src/transcript/presentation-policy.ts'
import { NO_DISCLOSURE, openTurns, toggleCall, toggleGroup, toggleRecent, toggleRows, toggleTurn, type Disclosure } from '../../src/transcript/disclosure.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'

const t = interpolateLocaleMessage
const base = (turn: number) => ({ seq: 1, updatedSeq: 1, turn })
const bash = (id: string, command: string): TranscriptEntryModel => ({
  ...base(1), id, kind: 'transcript-tool', step: 1, callId: id, name: 'bash', family: 'command', activity: 'commands', detail: command, arguments: '{}', startedAt: 0,
  terminal: { command, exitCode: 0, output: 'l1\nl2\nl3' }, result: { text: 'ok', isError: false, endedAt: 4_200 },
} as unknown as TranscriptEntryModel)
const web = (id: string, query: string): TranscriptEntryModel => ({
  ...base(1), id, kind: 'transcript-tool', step: 1, callId: id, name: 'web_search', family: 'web', activity: 'webSearch', detail: query, arguments: '{}', startedAt: 0,
  web: { kind: 'search', sources: [{ url: 'https://a.dev' }], truncated: false }, result: { text: `result ${query}`, isError: false, endedAt: 1_000 },
} as unknown as TranscriptEntryModel)
const user = (turn: number, text: string): TranscriptEntryModel => ({ seq: turn, updatedSeq: turn, turn, id: `user:${String(turn)}`, kind: 'transcript-user', text, images: [] })
const answer = (turn: number): TranscriptEntryModel => ({ seq: turn, updatedSeq: turn, turn, id: `assistant:${String(turn)}`, kind: 'transcript-assistant', step: 2, text: `done ${String(turn)}`, streaming: false })
const turnsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ turn: index + 1, startedAt: 0, endedAt: 9_000, outcome: 'completed' })) as never

/** The stream of a model under one level and disclosure: the kinds and ids of the rows of its first turn that carries a tool. */
function stream(mode: TranscriptViewMode, disclosure: Disclosure, entries: TranscriptEntryModel[], windowTurns = DEFAULT_TRANSCRIPT_PRESENTATION.windowTurns, turns = turnsOf(1)) {
  const policy = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode, process: PROCESS_POLICIES[mode], windowTurns }
  const inputs: StreamInputs = { policy, disclosure, liveTurnHeader: false, t, now: 9_000, queued: [] }
  return new StreamFacts().build(createTranscriptModel('spec', entries, false, 0, turns), inputs).turns
}
/** The items of a run row. */
const itemsOf = (row: unknown): { body?: unknown }[] => (row as { items: { body?: unknown }[] }).items
const twoBash = [user(1, 'go'), bash('b1', 'pnpm test'), bash('b2', 'pnpm build'), answer(1)]

describe('openTurns', () => {
  const reach = new Set([2, 3])
  it('opens nothing for a level with no openings', () => {
    expect([...openTurns(NO_DISCLOSURE, reach)]).toEqual([])
  })

  it('opens the Ctrl+O reach, and a second Ctrl+O (recent off) closes it again', () => {
    expect([...openTurns({ ...NO_DISCLOSURE, recent: true }, reach)].sort()).toEqual([2, 3])
    expect([...openTurns({ ...NO_DISCLOSURE, recent: false }, reach)]).toEqual([])
  })

  it('opens the turns Enter opened and folds the ones it folded, whatever the reach', () => {
    const flipped = { ...NO_DISCLOSURE, recent: true, turns: new Map([[2, false], [9, true]]) }
    expect([...openTurns(flipped, reach)].sort()).toEqual([3, 9])
  })

  it('keeps every turn a search holds open, whatever the reach and the openings say', () => {
    expect([...openTurns({ ...NO_DISCLOSURE, recent: true, turns: new Map([[5, true]]), forced: new Set([5, 1]) }, reach)].sort()).toEqual([1, 2, 3, 5])
  })
})

describe('the openings of the reader', () => {
  it('toggleTurn flips one turn from how it is drawn and leaves the value it was given unchanged', () => {
    const before = NO_DISCLOSURE
    const reach = new Set<number>()
    const on = toggleTurn(before, 4, reach)
    expect([...on.turns]).toEqual([[4, true]])
    expect([...toggleTurn(on, 4, reach).turns]).toEqual([])
    expect(before.turns.size).toBe(0)
  })

  it('a turn put back to what Ctrl-O gives it follows Ctrl-O again', () => {
    const reach = new Set([4])
    const open = { ...NO_DISCLOSURE, recent: true }
    const folded = toggleTurn(open, 4, reach)
    expect([...folded.turns]).toEqual([[4, false]])
    expect([...openTurns(folded, reach)]).toEqual([])
    const back = toggleTurn(folded, 4, reach)
    expect(back.turns.size).toBe(0)
    expect([...openTurns(back, reach)].sort()).toEqual([4])
  })

  it('toggleRecent opens or closes the newest turns whole and forgets the turns Enter folded', () => {
    const folded = { ...NO_DISCLOSURE, recent: true, turns: new Map<number, boolean>([[2, false], [5, true]]) }
    const off = toggleRecent(folded)
    expect(off.recent).toBe(false)
    expect([...off.turns]).toEqual([[5, true]])
    expect(toggleRecent(off).recent).toBe(true)
  })

  it('keeps a turn Enter folded folded when a newer turn moves the reach on', () => {
    let disclosure: Disclosure = { ...NO_DISCLOSURE, recent: true }
    disclosure = toggleTurn(disclosure, 2, new Set([2, 3]))
    expect([...openTurns(disclosure, new Set([2, 3]))].sort()).toEqual([3])
    expect([...openTurns(disclosure, new Set([3, 4]))].sort()).toEqual([3, 4])
  })

  it('closes the newest turns whole on Ctrl-O without reopening the turns Enter folded', () => {
    let disclosure: Disclosure = { ...NO_DISCLOSURE, recent: true }
    disclosure = toggleTurn(disclosure, 2, new Set([2, 3]))
    disclosure = toggleRecent(disclosure)
    expect(disclosure.recent).toBe(false)
    expect([...openTurns(disclosure, new Set([2, 3]))]).toEqual([])
  })

  it('keeps a turn Enter opened open through Ctrl-O and back', () => {
    let disclosure: Disclosure = toggleTurn(NO_DISCLOSURE, 4, new Set())
    expect([...openTurns(disclosure, new Set())]).toEqual([4])
    disclosure = toggleRecent(disclosure)
    expect([...openTurns(disclosure, new Set())]).toContain(4)
    disclosure = toggleRecent(disclosure)
    expect([...openTurns(disclosure, new Set())]).toContain(4)
  })

  it('toggleRows opens the entries not yet open, and closes them again once all of them are open', () => {
    expect(toggleRows(NO_DISCLOSURE, [])).toBe(NO_DISCLOSURE)
    const some = toggleRows({ ...NO_DISCLOSURE, rows: new Set(['a']) }, ['a', 'b'])
    expect([...some.rows].sort()).toEqual(['a', 'b'])
    expect([...toggleRows(some, ['a', 'b']).rows]).toEqual([])
  })

  it('toggleGroup opens a run as a whole, and folds it when it is open as a whole or every call is open', () => {
    const calls = ['c1', 'c2', 'c3']
    const opened = toggleGroup(NO_DISCLOSURE, 'c1', calls)
    expect([...opened.groups]).toEqual(['c1'])
    // The run is opened by its head, whatever calls it holds at that moment.
    expect(toggleGroup(NO_DISCLOSURE, 'c1', [...calls, 'c4']).groups.has('c1')).toBe(true)
    const closed = toggleGroup(opened, 'c1', calls)
    expect(closed.groups.has('c1')).toBe(false)
    // Every call open one by one counts as open: Enter on the head folds them all.
    const each = { ...NO_DISCLOSURE, rows: new Set(calls) }
    expect(toggleGroup(each, 'c1', calls).rows.size).toBe(0)
  })

  it('toggleCall flips one call, and an open run gives up being open as a whole: the other calls stay open one by one', () => {
    const calls = ['c1', 'c2', 'c3']
    const one = toggleCall(NO_DISCLOSURE, 'c1', calls, 'c2')
    expect([...one.rows]).toEqual(['c2'])
    expect(one.groups.size).toBe(0)
    const demoted = toggleCall({ ...NO_DISCLOSURE, groups: new Set(['c1']) }, 'c1', calls, 'c2')
    expect(demoted.groups.has('c1')).toBe(false)
    expect([...demoted.rows].sort()).toEqual(['c1', 'c3'])
  })
})

describe('what each level draws by default and under Ctrl+O', () => {
  it('draws Compact as one title with no tool rows, and Standard and Detailed as a run with its hint', () => {
    const compact = stream('compact', NO_DISCLOSURE, twoBash)[0]!.rows.map(row => row.kind)
    expect(compact).toEqual(['prompt', 'title', 'answer'])
    for (const mode of ['standard', 'detailed'] as const) {
      const rows = stream(mode, NO_DISCLOSURE, twoBash)[0]!.rows
      expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tools', 'answer'])
      expect(rows[1]).toMatchObject({ label: '2 tool calls · Ctrl+O to expand' })
    }
  })

  it('draws Verbose every call as a block with its body, and without the hint', () => {
    const rows = stream('verbose', NO_DISCLOSURE, twoBash)[0]!.rows
    expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tool', 'tool', 'answer'])
    expect(rows[2]).toMatchObject({ kind: 'tool', id: 'b1', target: 'pnpm test' })
  })

  it('opens every turn of Ctrl+O at Compact and Standard alike, and the reach stays Verbose', () => {
    for (const mode of ['compact', 'standard'] as const) {
      const rows = stream(mode, { ...NO_DISCLOSURE, recent: true }, twoBash)[0]!.rows
      expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tool', 'tool', 'answer'])
    }
  })

  it("reads Enter on a turn header as the turn's own state, whatever the level gives", () => {
    expect(stream('standard', { ...NO_DISCLOSURE, turns: new Map([[1, true]]) }, twoBash)[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tool', 'tool', 'answer'])
    expect(stream('standard', { ...NO_DISCLOSURE, recent: true, turns: new Map([[1, false]]) }, twoBash)[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tools', 'answer'])
  })

  it('mounts a turn a search holds open even when the window has left it out, and draws it Verbose', () => {
    const entries = [user(1, 'old'), bash('old-call', 'ls'), answer(1), user(2, 'new'), answer(2)]
    const turns = turnsOf(2)
    const windowed = stream('standard', NO_DISCLOSURE, entries, 1, turns)
    expect(windowed.map(turn => turn.number)).toEqual([2])
    const forced = stream('standard', { ...NO_DISCLOSURE, forced: new Set([1]) }, entries, 1, turns)
    expect(forced.map(turn => turn.number)).toEqual([1, 2])
    expect(forced[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tool', 'answer'])
  })
})

describe('a run keeps its shape when one of its calls opens', () => {
  const lone = [user(1, 'go'), web('w1', 'a'), web('w2', 'b'), web('w3', 'c'), answer(1)]

  it('stays one run of three calls when the second call opens, and the head keeps the id of the first call', () => {
    const closed = stream('standard', NO_DISCLOSURE, lone)[0]!.rows
    const opened = stream('standard', { ...NO_DISCLOSURE, rows: new Set(['w2']) }, lone)[0]!.rows
    expect(opened.map(row => row.kind)).toEqual(closed.map(row => row.kind))
    expect(opened[2]).toMatchObject({ kind: 'tools', id: 'w1', items: [{ label: '"a"' }, { label: '"b"' }, { label: '"c"' }] })
    const items = itemsOf(opened[2])
    expect(items[0]!.body).toBeUndefined()
    expect(items[1]!.body).toBeDefined()
    expect(items[2]!.body).toBeUndefined()
  })

  it('opens every call of the run when the head opens it as a whole, and a call joining an open run comes in open', () => {
    const whole = stream('standard', { ...NO_DISCLOSURE, groups: new Set(['w1']) }, lone)[0]!.rows
    const items = itemsOf(whole[2])
    expect(items.every(item => item.body !== undefined)).toBe(true)
    const joined = stream('standard', { ...NO_DISCLOSURE, groups: new Set(['w1']) }, [...lone.slice(0, 4), web('w4', 'd'), answer(1)])[0]!.rows
    const joinedItems = itemsOf(joined[2])
    expect(joinedItems).toHaveLength(4)
    expect(joinedItems[3]!.body).toBeDefined()
  })
})
