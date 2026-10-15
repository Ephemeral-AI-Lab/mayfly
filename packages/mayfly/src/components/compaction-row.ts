/**
 * The compaction row: one context compaction in the stream. While it runs it is a breathing `●`, the title, a bar of
 * the estimated progress (`▰▱`) with its percentage, and the stage (`summarizing` with the seconds, then `applying`).
 * The Harness reports no progress inside a compaction, so the share is an estimate that grows with the time spent
 * summarizing and never passes 90% until the summary lands; the bar then fills to 100% over 800 ms, and it stays full.
 * With no context window to measure against, the bar still moves but the percentage is not written (`bar.labeled`).
 * Settled it is `✓`, what was compacted, the full bar, the context occupancy before and after, the token estimate, and
 * `auto` for a compaction the context pressure started. A row that does not fit sheds the bar first, then the token
 * estimate, then `auto`; at the Compact level, and below the width that holds a bar, it is one line: the title, the
 * percentage and stage (the change once settled). A failure is a `✗` with its reason. A pure function of facts: the
 * texts arrive translated and final, and the clock and the fill belong to core.
 *
 * @module components/compaction-row
 */

import { ui, type MayflyInlineSpan, type MayflyListBodyNode, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** The progress bar of a compaction: the estimated share done, in percent. */
export interface CompactionBar {
  /** The share when the row was last drawn at rest: while summarizing the estimate itself, and the share the summary landed at while applying. */
  readonly from: number
  /** The share it moves to: equal to `from` while summarizing, 100 once the summary has landed. */
  readonly to: number
  /** Whether the bar moves from `from` to `to`: the summary has landed and the one-shot has not run out. */
  readonly drain: boolean
  /** The compaction's identity for the one-shot: the same number for the whole life of the row. */
  readonly rev: number
  /** Whether the bar prints its share: false when the context window is unknown, so the guess is drawn but never written as a number. */
  readonly labeled: boolean
}

/** The facts of one compaction row. Every text is final: translated, sanitized, and without escape sequences. */
export interface CompactionFacts {
  readonly state: 'running' | 'ok' | 'error'
  /** `Compacting context`, `Compacted 84 items`, or `Compaction failed: <reason>`. */
  readonly title: string
  /** The Compact level: one line, no bar. */
  readonly compact: boolean
  /** The progress bar. */
  readonly bar?: CompactionBar
  /** While running: the stage (`summarizing`, `applying`), then the elapsed time (`4s`) while summarizing, joined by ` · `. */
  readonly progress?: readonly string[]
  /** While running: the estimated share done, as the one-line form writes it before the stage. */
  readonly percent?: number
  /** Settled: the context occupancy change (`context 91% → 9%`). */
  readonly change?: string
  /** Settled: the estimate (`~148k → ~12k tokens`). */
  readonly tokens?: string
  /** `auto` for a compaction the context pressure started. */
  readonly trigger?: string
}

/** The row width from which the bar is drawn; narrower, the row is the one line. */
export const COMPACTION_BAR_MIN_WIDTH = 56

/** How long the bar takes to fill from where the summary landed it to 100%. */
export const COMPACTION_DRAIN_MS = 800

const STATE_TONE = { ok: 'success', error: 'danger' } as const

/** The glyph of the row: a dot that breathes while it runs (one motion channel, so the rest of the line is still). */
function lead(facts: CompactionFacts): readonly MayflyInlineSpan[] {
  if (facts.state === 'running') return [{ text: '', motion: 'loader', variant: 'breath' }, { text: ' ' }]
  return [{ text: facts.state === 'ok' ? '✓ ' : '✗ ', tone: STATE_TONE[facts.state] }]
}

/** The title after the glyph: a failure is the title in `danger`, the rest in text color. */
function title(facts: CompactionFacts): MayflyUiNode {
  return ui.richText([...lead(facts), facts.state === 'error' ? { text: facts.title, tone: 'danger' } : { text: facts.title }])
}

/** The one-line form: the title, then what is known of the change or the stage. */
function oneLine(facts: CompactionFacts): MayflyUiNode {
  const stage = facts.progress?.[0]
  const tail = facts.state === 'running'
    ? [...stage === undefined || facts.percent === undefined ? facts.progress ?? [] : [`${String(facts.percent)}% ${stage}`, ...facts.progress!.slice(1)], ...facts.trigger === undefined ? [] : [facts.trigger]]
    : [...facts.change === undefined ? (facts.tokens === undefined ? [] : [facts.tokens]) : [facts.change], ...facts.trigger === undefined ? [] : [facts.trigger]]
  return ui.richText([...lead(facts), facts.state === 'error' ? { text: facts.title, tone: 'danger' } : { text: facts.title }, ...tail.length === 0 ? [] : [{ text: ` · ${tail.join(' · ')}`, tone: 'muted' as const }]], { overflow: 'truncate' })
}

/** The bar with its percentage while the row runs, and without once it is settled (the change says it). */
function bar(facts: CompactionFacts, shape: CompactionBar): MayflyUiNode {
  return ui.progress({
    style: 'cells',
    width: 10,
    value: shape.drain || facts.state !== 'running' ? shape.to : shape.from,
    max: 100,
    showCount: false,
    showPercent: facts.state === 'running' && shape.labeled,
    tone: facts.state === 'running' ? 'primary' : 'success',
    ...shape.drain ? { transition: { from: shape.from, ms: COMPACTION_DRAIN_MS, rev: shape.rev } } : {},
  })
}

const muted = (text: string): MayflyUiNode => ui.richText([{ text, tone: 'muted' }])

/** The wide form: title, bar, and the parts that shed from the end (the estimate, then `auto`) as the row narrows. */
function wide(facts: CompactionFacts, shape: CompactionBar): MayflyUiNode {
  const children: MayflyUiChild[] = [
    ui.child(title(facts), { priority: 0, overflow: 'truncate' }),
    ui.child(bar(facts, shape), { priority: 4, overflow: 'hide' }),
    ...facts.state === 'running'
      ? [ui.child(muted(facts.progress?.join(' · ') ?? ''), { priority: 1, overflow: 'hide' })]
      : facts.change === undefined ? [] : [ui.child(muted(facts.change), { priority: 1, overflow: 'hide' })],
    ...facts.state === 'ok' && facts.tokens !== undefined ? [ui.child(muted(`· ${facts.tokens}`), { priority: 3, overflow: 'hide' })] : [],
    ...facts.trigger === undefined ? [] : [ui.child(muted(`· ${facts.trigger}`), { priority: 2, overflow: 'hide' })],
  ]
  return ui.stack.row(children, { gap: 1 })
}

/**
 * The body of a compaction row.
 * @param facts - the compaction's state and texts.
 * @returns the node a stream row paints as its body: one line, or the bar form that falls back to one line on a narrow row.
 *   Every node in it is content (rich text, a bar, stacks of them), which a list body admits.
 */
export function CompactionRow(facts: CompactionFacts): MayflyListBodyNode {
  if (facts.state === 'error' || facts.compact || facts.bar === undefined) return oneLine(facts) as MayflyListBodyNode
  return ui.stack.column([
    ui.child(wide(facts, facts.bar), { when: { minWidth: COMPACTION_BAR_MIN_WIDTH } }),
    ui.child(oneLine(facts), { when: { maxWidth: COMPACTION_BAR_MIN_WIDTH - 1 } }),
  ]) as MayflyListBodyNode
}
