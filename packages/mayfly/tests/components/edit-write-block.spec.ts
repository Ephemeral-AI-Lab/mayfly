/**
 * Decision tests of the edit and write blocks: a settled edit as its diffstat line with its hunks, a created or
 * overwritten file as its code, a failed or cut-off change as its reason alone, the body caps of each tier, and the rows
 * of a large change, all fitting the width they are given.
 * @module components-edit-write-block
 */

import { describe, expect, it } from 'vitest'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { TranscriptView, type StreamRow, type TranscriptViewFacts } from '../../src/components/transcript-view.ts'
import type { ToolBlockFacts } from '../../src/components/tool-line.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptEntryModel, TranscriptFileChangeModel, TranscriptModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { TranscriptPresentationPolicy, type TranscriptPresentationSnapshot } from '../../src/transcript/presentation-policy.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { NO_DISCLOSURE, type Disclosure } from '../../src/transcript/disclosure.ts'
import { callsOf, verboseRow, STANDARD_DIFF_ROWS, VERBOSE_CHANGE_ROWS, OPEN_BODY_ROWS } from '../../src/transcript/tool-calls.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { plainColors, plainText } from '../helpers.ts'

const t = interpolateLocaleMessage
const NOON = Date.UTC(2026, 0, 1, 12, 5)
let seq = 0
const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })

/** `count` numbered lines, `prefix` before the number. */
const numbered = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`).join('\n')

/** An edit that settled: its path, the change, and its result (failed when `error` is given). */
const edit = (change: TranscriptFileChangeModel | undefined, overrides: Record<string, unknown> = {}): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name: 'edit', family: 'edit', activity: 'edit',
  detail: change?.path ?? 'src/a.ts', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 2_000 },
  ...(change === undefined ? {} : { change }), ...overrides,
} as unknown as TranscriptEntryModel)

/** A write that settled: a created file (its `write` facts) or an overwrite (counts only). */
const write = (change: TranscriptFileChangeModel, overrides: Record<string, unknown> = {}): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name: 'write', family: 'write', activity: 'write',
  detail: change.path, arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 1_000 }, change, ...overrides,
} as unknown as TranscriptEntryModel)

/** The stream's facts of entries at a work-details level; the turn is closed unless `running` says otherwise. */
function facts(entries: TranscriptEntryModel[], mode: TranscriptPresentationSnapshot['mode'], options: { readonly running?: boolean, readonly disclosure?: Disclosure } = {}): TranscriptViewFacts {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ transcriptView: mode })
  const inputs: StreamInputs = { policy: policy.snapshot(), disclosure: options.disclosure ?? NO_DISCLOSURE, liveTurnHeader: false, t, now: NOON + 60_000, queued: [] }
  const turns = options.running === true
    ? [{ turn: 1, startedAt: NOON }]
    : [{ turn: 1, startedAt: NOON, endedAt: NOON + 9_000, outcome: 'completed' }]
  return new StreamFacts().build(createTranscriptModel('spec', entries, options.running === true, 0, turns as TranscriptModel['turns']), inputs)
}

/** The first block of a turn, which is the change's own row. */
const blockOf = (value: TranscriptViewFacts): ToolBlockFacts & { readonly id: string, readonly kind: 'tool' } => {
  const row = value.turns[0]!.rows.find(candidate => candidate.kind === 'tool') as StreamRow & { kind: 'tool' }
  return row as ToolBlockFacts & { readonly id: string, readonly kind: 'tool' }
}

/** The stream drawn at a width, as plain rows. */
function drawn(value: TranscriptViewFacts, width: number): string[] {
  const compiled = compileMayflyUiNode(TranscriptView(value), {
    components: fakeMayflyComponents(), colors: plainColors(), getViewport: () => ({ columns: width, rows: 1000 }), screenMode: 'main', emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width).map(row => plainText(row))
}

/** A one-line change of `path` replacing `before` with `after`. */
const oneHunk = (path: string, before: string, after: string): TranscriptFileChangeModel => ({
  path, added: 1, removed: 1, hunks: [{ before, after }], hiddenLines: 0,
})

/** A change of one hunk whose changed lines run to `count` rows. */
const longHunk = (path: string, count: number): TranscriptFileChangeModel => ({
  path, added: count, removed: count, hunks: [{ before: numbered(count, 'old'), after: numbered(count, 'new') }], hiddenLines: 0,
})

describe('edit blocks', () => {
  it('draws a single-hunk edit as its line with the diffstat and its hunk, highlighted by the file\'s language', () => {
    const value = facts([edit(oneHunk('src/a.ts', 'const a = 1', 'const a = 2'))], 'standard')
    const block = blockOf(value)
    expect(block).toMatchObject({ kind: 'tool', name: 'Edit', target: 'src/a.ts', stat: { added: 1, removed: 1 } })
    expect(block.diff).toEqual([{ before: 'const a = 1', after: 'const a = 2', language: 'typescript' }])
    expect(block).not.toHaveProperty('outcome')
    expect(drawn(value, 120).some(row => row.includes('✓ Edit(src/a.ts) · +1 −1 ▮▮▮▮▮▮▮▮') || row.includes('Edit(src/a.ts) · +1 −1'))).toBe(true)
  })

  it('draws a multi-hunk edit as one diff per hunk, with a `⋯` between the hunks and the stat over the whole change', () => {
    const change: TranscriptFileChangeModel = {
      path: 'src/b.ts', added: 2, removed: 2,
      hunks: [{ before: 'a', after: 'b' }, { before: 'c', after: 'd' }], hiddenLines: 0,
    }
    const value = facts([edit(change)], 'verbose')
    const block = blockOf(value)
    expect(block.stat).toEqual({ added: 2, removed: 2 })
    expect(block.diff).toHaveLength(2)
    const rows = drawn(value, 120)
    expect(rows.some(row => row.trim() === '⋯')).toBe(true)
  })

  it('caps a long hunk by tier: six rows at Standard, twelve at Verbose, forty once Ctrl+O opens the turn, with the rows left out named', () => {
    const change = longHunk('src/c.ts', 30)
    const cap = (mode: 'standard' | 'verbose', open: boolean) => {
      const value = facts([edit(change)], mode, open ? { disclosure: { ...NO_DISCLOSURE, recent: true } } : {})
      return blockOf(value)
    }
    const standard = cap('standard', false)
    expect(standard.diff?.[0]?.maxRows).toBe(STANDARD_DIFF_ROWS)
    expect(standard.diff?.[0]?.tail).toMatch(/^… \+\d+ rows · Ctrl\+O$/u)
    const verbose = cap('verbose', false)
    expect(verbose.diff?.[0]?.maxRows).toBe(VERBOSE_CHANGE_ROWS)
    const opened = cap('verbose', true)
    expect(opened.diff?.[0]?.maxRows).toBe(OPEN_BODY_ROWS)
    // Open, the rows the cap still leaves out are named without the Ctrl+O hint.
    expect(opened.diff?.[0]?.tail).toMatch(/^… \+\d+ rows$/u)
  })

  it('draws a failed edit as its reason alone, with no hunk', () => {
    const failed = facts([edit(oneHunk('src/d.ts', 'a', 'b'), { result: { text: 'old_string not found in file', isError: true, endedAt: 1_000 } })], 'verbose')
    const block = blockOf(failed)
    expect(block).toMatchObject({ state: 'error', name: 'Edit', outcome: 'old_string not found in file' })
    expect(block).not.toHaveProperty('diff')
    expect(block).not.toHaveProperty('stat')
  })

  it('draws a change cut off with its turn as cancelled, with no outcome and no hunk', () => {
    const cut = facts([edit(oneHunk('src/e.ts', 'a', 'b'), { result: undefined })], 'verbose')
    expect(blockOf(cut)).toMatchObject({ state: 'cancelled', name: 'Edit' })
    expect(blockOf(cut)).not.toHaveProperty('outcome')
    expect(blockOf(cut)).not.toHaveProperty('diff')
  })

  it('shows the diffstat only of a change that settled, and the count of an overwrite with no hunk', () => {
    const overwrite = write({ path: 'src/o.ts', added: 3, removed: 2, hunks: [], hiddenLines: 0 })
    const block = blockOf(facts([overwrite], 'verbose'))
    expect(block).toMatchObject({ name: 'Write', target: 'src/o.ts', stat: { added: 3, removed: 2 } })
    expect(block).not.toHaveProperty('diff')
    expect(block).not.toHaveProperty('code')
  })
})

describe('write blocks', () => {
  const created: TranscriptFileChangeModel = {
    path: 'notes/new.md', added: 3, removed: 0, hunks: [], hiddenLines: 0,
    write: { bytes: 12, lines: 3, head: ['# Notes', 'first', 'second'] },
  }

  it('draws a created file as its size and its numbered code, with no language row and no hunk', () => {
    const value = facts([write(created)], 'verbose')
    const block = blockOf(value)
    expect(block).toMatchObject({ name: 'Write', target: 'notes/new.md', outcome: '3 lines · 12 B' })
    expect(block.code).toEqual({ text: '# Notes\nfirst\nsecond', language: 'markdown' })
    expect(block).not.toHaveProperty('stat')
    expect(block).not.toHaveProperty('diff')
    expect(drawn(value, 120).some(row => row.includes('# Notes'))).toBe(true)
  })

  it('draws a large created file at most twelve rows of its head at Verbose, with the rows left out counted and named', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `row ${String(index + 1)}`)
    const large: TranscriptFileChangeModel = { path: 'src/big.ts', added: 900, removed: 0, hunks: [], hiddenLines: 0, write: { bytes: 4_096, lines: 900, head: lines } }
    const value = facts([write(large)], 'verbose')
    const block = blockOf(value)
    expect(block.code?.text.split('\n')).toHaveLength(VERBOSE_CHANGE_ROWS)
    expect(block.more).toMatch(/^… \+\d+ more · Ctrl\+O$/u)
    const opened = blockOf(facts([write(large)], 'verbose', { disclosure: { ...NO_DISCLOSURE, recent: true } }))
    expect(opened.code?.text.split('\n')).toHaveLength(OPEN_BODY_ROWS)
  })

  it('draws a failed write as its reason alone, and a cancelled write as muted with no outcome and no code', () => {
    const failed = blockOf(facts([write(created, { result: { text: 'permission denied', isError: true, endedAt: 1 } })], 'standard'))
    expect(failed).toMatchObject({ state: 'error', outcome: 'permission denied' })
    expect(failed).not.toHaveProperty('code')
    const cancelled = blockOf(facts([write(created, { result: undefined })], 'standard', { running: false }))
    expect(cancelled).toMatchObject({ state: 'cancelled', name: 'Write' })
    expect(cancelled).not.toHaveProperty('code')
    expect(cancelled).not.toHaveProperty('outcome')
  })
})

describe('change rows at the tiers', () => {
  it('shows a settled change at Standard as its own block, never inside a run', () => {
    const value = facts([edit(oneHunk('src/a.ts', 'a', 'b')), edit(oneHunk('src/b.ts', 'c', 'd'))], 'standard')
    expect(value.turns[0]!.rows.filter(row => row.kind === 'tool')).toHaveLength(2)
    expect(value.turns[0]!.rows.some(row => row.kind === 'tools')).toBe(false)
  })

  it('folds a change into the Compact title with its counts, and keeps it out of the lines', () => {
    const value = facts([edit(oneHunk('src/a.ts', 'a', 'b')), edit(oneHunk('src/b.ts', 'c', 'd'))], 'compact')
    expect(value.turns[0]!.rows.map(row => row.kind)).toEqual(['title'])
    expect(value.turns[0]!.rows[0]).toMatchObject({ kind: 'title', text: '2 tool calls · 2s · +2 −2' })
  })

  it('keeps the change of a Verbose-opened block at the tier\'s cap, and the verbose row of a call draws the same diff', () => {
    const call = callsOf(edit(longHunk('src/c.ts', 30)), true, t, 0)[0]!
    const row = verboseRow(call, false, t, 'standard') as Extract<StreamRow, { kind: 'tool' }>
    expect(row.diff?.[0]?.maxRows).toBe(STANDARD_DIFF_ROWS)
    const verbose = verboseRow(call, false, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>
    expect(verbose.diff?.[0]?.maxRows).toBe(VERBOSE_CHANGE_ROWS)
  })

  it('fits every change row in the width it is given, at 120 and 40 columns', () => {
    const entries = [edit(longHunk('src/c.ts', 30)), write({ path: 'notes/new.md', added: 3, removed: 0, hunks: [], hiddenLines: 0, write: { bytes: 12, lines: 3, head: ['# Notes', 'first', 'second'] } })]
    for (const mode of ['compact', 'standard', 'detailed', 'verbose'] as const) {
      for (const width of [120, 40]) {
        const rows = drawn(facts(entries, mode), width)
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })
})
