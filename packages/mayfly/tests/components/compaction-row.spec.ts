/**
 * Decision tests of the compaction row: the running form with its estimated share, the settled form with the context
 * change and the token estimate, the failure row, the bar's width threshold and the order its parts shed, the fill's
 * one-shot transition, and every row fitting its width. The stream's mapping of a compaction (the stage, the estimate,
 * the settled look held until the bar fills, the Compact and Verbose tiers, a manual `/compact` after its turn, and a
 * session without a context window) is decided through `StreamFacts`.
 * @module components-compaction-row
 */

import { describe, expect, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { COMPACTION_BAR_MIN_WIDTH, COMPACTION_DRAIN_MS, CompactionRow, type CompactionFacts } from '../../src/components/compaction-row.ts'
import { ADVERSARIAL, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES } from '../../src/transcript/presentation-policy.ts'
import { progressAt, StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { NO_DISCLOSURE } from '../../src/transcript/disclosure.ts'
import type { StreamRow, StreamTurn } from '../../src/components/transcript-view.ts'
import { formatTokens } from '../../src/transcript/status-context.ts'

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu

/** The row as a screen paints it at a width (the main screen mode the stream is drawn in), escape sequences removed. */
function render(facts: CompactionFacts, width: number): string[] {
  const compiled = compileMayflyUiNode(CompactionRow(facts), {
    components: fakeMayflyComponents(),
    colors: COLORS as MayflySemanticColors,
    getViewport: () => ({ columns: width, rows: 40 }),
    screenMode: 'main',
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width).map(line => line.replace(ANSI, ''))
}

/** Every node of a tree with the given kind, in order. */
function nodesOf(node: unknown, kind: string): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(item => nodesOf(item, kind))
  const record = node as Record<string, unknown>
  const own = record.kind === kind ? [record] : []
  return [...own, ...Object.values(record).flatMap(value => nodesOf(value, kind))]
}

const BAR_RUNNING = { from: 40, to: 40, drain: false, rev: 1 }
const BAR_SETTLED = { from: 100, to: 100, drain: false, rev: 1 }
const settled: CompactionFacts = {
  state: 'ok', title: 'Compacted 84 items', compact: false, bar: BAR_SETTLED, change: 'context 91% → 9%', tokens: '~148k → ~12k tokens', trigger: 'auto',
}
const running: CompactionFacts = {
  state: 'running', title: 'Compacting context', compact: false, bar: BAR_RUNNING, progress: ['summarizing', '4s'], percent: 40, trigger: 'auto',
}

describe('CompactionRow', () => {
  it('draws the running form with its bar, its estimated share, the stage and the elapsed time', () => {
    // The glyph before the title is a breathing dot; the text after it is decided.
    expect(render(running, 120)[0]!.slice(2)).toBe('Compacting context ▰▰▰▰▱▱▱▱▱▱ 40% summarizing · 4s · auto')
  })

  it('draws the settled form with the full bar, the context change, the token estimate and the trigger', () => {
    expect(render(settled, 120)).toEqual(['✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · ~148k → ~12k tokens · auto'])
  })

  it('leaves out the trigger of a manual compaction and keeps the rest of the settled form', () => {
    const manual: CompactionFacts = { state: 'ok', title: settled.title, compact: false, bar: BAR_SETTLED, ...settled.change === undefined ? {} : { change: settled.change }, ...settled.tokens === undefined ? {} : { tokens: settled.tokens } }
    expect(render(manual, 120)).toEqual(['✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · ~148k → ~12k tokens'])
  })

  it('switches to one line below the bar width, and draws the bar from that width on', () => {
    expect(COMPACTION_BAR_MIN_WIDTH).toBe(56)
    expect(render(settled, 56)[0]).toContain('▰▰▰▰▰▰▰▰▰▰')
    expect(render(settled, 55)[0]).not.toContain('▰')
    expect(render(settled, 40)).toEqual(['✓ Compacted 84 items · context 91% → 9%…'])
    expect(render(running, 40)).toEqual(['● Compacting context · 40% summarizing …'])
  })

  it('sheds the bar first, then the token estimate, then the trigger as the row narrows', () => {
    expect(render(settled, 80)[0]).toBe('✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · ~148k → ~12k tokens · auto')
    expect(render(settled, 70)[0]).toBe('✓ Compacted 84 items context 91% → 9% · ~148k → ~12k tokens · auto')
    expect(render(settled, 64)[0]).toBe('✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · auto')
    expect(render(settled, 60)[0]).toBe('✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · auto')
  })

  it('is one line at the Compact level, with the change and the trigger and no bar', () => {
    expect(render({ ...settled, compact: true }, 120)).toEqual(['✓ Compacted 84 items · context 91% → 9% · auto'])
    expect(render({ ...running, compact: true }, 120)[0]).not.toContain('▰')
  })

  it('draws a settled form without a known change, and a running one without its stage line at the narrow width', () => {
    const { change: _change, ...noChange } = settled
    expect(render(noChange, 120)).toEqual(['✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ · ~148k → ~12k tokens · auto'])
    expect(render(noChange, 40)).toEqual(['✓ Compacted 84 items · ~148k → ~12k tok…'])
    const { progress: _progress, percent: _percent, ...unstaged } = running
    expect(render(unstaged, 40)).toEqual(['● Compacting context · auto'])
  })

  it('draws a failure as one line with the reason in danger, bar or not', () => {
    const failed: CompactionFacts = { state: 'error', title: 'Compaction failed: timeout', compact: false, bar: BAR_RUNNING }
    expect(render(failed, 120)).toEqual(['✗ Compaction failed: timeout'])
    expect(render(failed, 40)).toEqual(['✗ Compaction failed: timeout'])
  })

  it('drains the bar once from where the summary left it, with the same revision for the life of the row', () => {
    const drain = (rev: number) => nodesOf(CompactionRow({ ...settled, bar: { from: 40, to: 100, drain: true, rev } }), 'progress')
    const [bar] = drain(7)
    expect(bar).toMatchObject({ value: 100, max: 100, transition: { from: 40, ms: COMPACTION_DRAIN_MS, rev: 7 } })
    // A bar at rest has no transition.
    const [still] = nodesOf(CompactionRow(settled), 'progress')
    expect(still).toMatchObject({ value: 100 })
    expect(still).not.toHaveProperty('transition')
  })

  it('fits every adversarial title and change at each width', () => {
    for (const { name, text } of ADVERSARIAL) {
      for (const width of [120, 80, 60, 40, 20, 10]) {
        expectLinesFit(`CompactionRow settled/${name}`, render({ ...settled, title: text, change: text, tokens: text }, width), width)
        expectLinesFit(`CompactionRow running/${name}`, render({ ...running, progress: [text, '4s'] }, width), width)
        expectLinesFit(`CompactionRow failed/${name}`, render({ state: 'error', title: `Compaction failed: ${text}`, compact: false }, width), width)
      }
    }
  })
})

describe('compaction rows in the stream', () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 5)
  const t = (key: string, values?: Record<string, unknown>): string => key.replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? ''))
  let seq = 0
  const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })
  const user = (turn: number): TranscriptEntryModel => ({ ...base(turn), id: `user:${String(seq + 1)}`, kind: 'transcript-user', text: 'go', images: [] })
  const compaction = (turn: number, overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-compaction' }>> = {}): TranscriptEntryModel => ({
    ...base(turn), id: `compaction:${String(seq + 1)}`, kind: 'transcript-compaction', state: 'running', trigger: 'auto', startedAt: NOW, compactionId: 'c1', ...overrides,
  } as TranscriptEntryModel)
  const stream = (entries: TranscriptEntryModel[], inputs: Partial<StreamInputs>, turns: StreamTurn[] = []): StreamTurn[] => new StreamFacts().build(
    createTranscriptModel('spec', entries, false, 0, turns.length === 0 ? [{ turn: 1, startedAt: NOW }] : undefined),
    { policy: DEFAULT_TRANSCRIPT_PRESENTATION, disclosure: NO_DISCLOSURE, liveTurnHeader: false, t, queued: [], now: NOW, ...inputs },
  ).turns as StreamTurn[]
  const rowsOf = (turns: readonly StreamTurn[]): StreamRow[] => turns.flatMap(turn => [...turn.rows])
  const compactionRow = (turns: readonly StreamTurn[]): Extract<StreamRow, { kind: 'compaction' }> => rowsOf(turns).find((row): row is Extract<StreamRow, { kind: 'compaction' }> => row.kind === 'compaction')!

  it('shows the running stage with the estimated share, and says applying once the summary lands', () => {
    const summarizing = compactionRow(stream([user(1), compaction(1)], { now: NOW + 4_000 }))
    expect(summarizing.facts).toMatchObject({ state: 'running', percent: progressAt(4_000, undefined), progress: ['summarizing', '4s'], trigger: 'auto' })
    // The summary has landed (the end record follows it) and the fill has not finished: the stage is applying.
    const landed = compaction(1, { state: 'ok', summaryAt: NOW + 10_000, endedAt: NOW + 10_000, shadowedCount: 84, shadowedTokens: 148_000 })
    const applying = compactionRow(stream([user(1), landed], { now: NOW + 10_500 }))
    expect(applying.facts).toMatchObject({ state: 'running', progress: ['applying'], bar: { drain: true } })
  })

  it('holds the settled look until the bar has filled, one second after the summary lands', () => {
    const entry = compaction(1, { state: 'ok', summaryAt: NOW + 10_000, endedAt: NOW + 10_000, shadowedCount: 84, shadowedTokens: 148_000 })
    expect(compactionRow(stream([user(1), entry], { now: NOW + 10_500 })).facts).toMatchObject({ state: 'running' })
    expect(compactionRow(stream([user(1), entry], { now: NOW + 11_000 })).facts).toMatchObject({ state: 'ok', title: 'Compacted 84 items' })
  })

  it('draws the context change from the occupancy marks, and omits it when no window is known', () => {
    const entry = compaction(1, { state: 'ok', endedAt: NOW + 9_000, shadowedCount: 84, shadowedTokens: 148_000 })
    const withWindow = compactionRow(stream([user(1), entry], { now: NOW + 60_000, compactions: [{ id: 'c1', before: 58_000, after: 6_000, window: 64_000 }] }))
    // The occupancy rounds up, and the tokens read as the status bar writes them (KiB steps).
    expect(withWindow.facts).toMatchObject({ state: 'ok', change: 'context 91% → 10%', tokens: '~56.6k → ~5.9k tokens' })
    const noWindow = compactionRow(stream([user(1), entry], { now: NOW + 60_000 }))
    // Without the marks the estimate of the shadowed history stands alone, in the status bar's format.
    expect(noWindow.facts).toMatchObject({ state: 'ok', tokens: `~${formatTokens(148_000)} tokens` })
    expect(noWindow.facts).not.toHaveProperty('change')
  })

  it('reads a failure as its reason, and a manual compaction after its turn as a trailing block', () => {
    const failed = compactionRow(stream([user(1), compaction(1, { state: 'error', error: 'provider\ntimeout' })], { now: NOW + 3_000 }))
    expect(failed.facts).toEqual({ state: 'error', title: 'Compaction failed: provider', compact: false })
    const turns = stream([user(1), compaction(1, { trigger: 'manual', state: 'ok', endedAt: NOW + 2_000, shadowedCount: 3 })], { now: NOW + 3_000 }, [{ id: 'turn:1', number: 1, rows: [] }])
    expect(turns[0]!.after?.map(row => row.kind)).toEqual(['compaction'])
  })

  it('draws the Compact level as one line, and the Verbose level opens the summary under the row', () => {
    const entry = compaction(1, { state: 'ok', endedAt: NOW + 9_000, shadowedCount: 84, shadowedTokens: 148_000, summary: 'Kept the plan.\nDropped the logs.' })
    const compact = compactionRow(stream([user(1), entry], { now: NOW + 60_000, policy: { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } }))
    expect(compact.facts.compact).toBe(true)
    const verbose = compactionRow(stream([user(1), entry], { now: NOW + 60_000, policy: { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'verbose', process: PROCESS_POLICIES.verbose } }))
    expect(verbose.facts.compact).toBe(false)
    expect(verbose.summary).toEqual(['Kept the plan.', 'Dropped the logs.'])
    expect(verbose).not.toHaveProperty('hint')
    const standard = compactionRow(stream([user(1), entry], { now: NOW + 60_000 }))
    expect(standard.hint).toBe('Ctrl+O summary')
    expect(standard.summary).toBeUndefined()
  })
})
