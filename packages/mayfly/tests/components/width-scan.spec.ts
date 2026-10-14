/**
 * Width scan of the components area: every Phase 3 content renderer (the stream's tool, reasoning, compaction, and
 * header rows, the activity row, the notification line, the decision card, the search line, and a selection band) draws
 * every row within the width it was given, at every scan width, for the adversarial strings (wide characters, ZWJ
 * emoji, ANSI-laden and linked text). A compile that falls back to its error component fails the scan, so a row cannot
 * pass by being replaced.
 * @module components-width-scan
 */

import { describe, expect, it } from 'vitest'
import { ui, type MayflyListItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { SearchLine, type MayflySearchLineOptions } from '../../src/core/search-line.ts'
import { ActivityRow, type ActivityFacts } from '../../src/components/activity-row.ts'
import { NotificationLine, type NotificationRowFacts } from '../../src/components/notification-line.ts'
import { CompactionRow, type CompactionFacts } from '../../src/components/compaction-row.ts'
import { DecisionCard, type DecisionCardFacts } from '../../src/components/decision-card.ts'
import { TranscriptView, type StreamRow } from '../../src/components/transcript-view.ts'
import { ADVERSARIAL, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'

/** The widths every Phase 3 renderer is scanned at: wide, the 80 and 60 columns of a split, the 40 of the tier edge, and narrow. */
const WIDTHS = [120, 80, 60, 40, 28, 20, 10] as const

const colors = COLORS as MayflySemanticColors

/**
 * Compile a node the way a mounted screen does, and assert it compiled: a refused node paints its error component, which
 * would hide a width bug in the renderer under test.
 * @param node - the node to draw.
 * @param width - the viewport width.
 * @returns the rows at that width.
 */
function render(node: MayflyUiNode, width: number): string[] {
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(),
    colors,
    getViewport: () => ({ columns: width, rows: 1000 }),
    screenMode: 'main',
    emit: () => {},
  })
  if (!compiled.ok) throw new Error(`node refused at width ${width}: ${compiled.message}`)
  return compiled.value.component.render(width)
}

/**
 * Compile the stream the way a mounted slot paints it, and render it at one width.
 * @param rows - the rows of the second turn.
 * @param width - the viewport width.
 * @param text - the adversarial text, which also fills the closing line and the queued message.
 * @returns the rows at that width.
 */
function renderStream(rows: readonly StreamRow[], width: number, text: string): string[] {
  const node = TranscriptView({
    turns: [
      { id: 'turn:1', number: 1, closing: `Worked for ${text} · done 10:13`, rows: [{ kind: 'prompt', id: 'u0', text: 'first', images: [], open: false }] },
      { id: 'turn:2', number: 2, closing: text, rows },
    ],
    queued: [{ id: 'q', text, suffix: '⏎ queued' }],
  })
  return render(node, width)
}

/** The stream rows of one adversarial text: every content-rendering row kind, in each of its tiers and shapes. */
function streamRows(text: string): StreamRow[] {
  const compaction: CompactionFacts = { state: 'running', title: text, compact: false, bar: { from: 40, to: 40, drain: false, rev: 1 }, progress: ['summarizing', text], percent: 40 }
  return [
    { kind: 'prompt', id: 'u1', text, images: [{ attachmentId: 'a1', alt: `[image] 1 · ${text}` }], open: false },
    { kind: 'prompt', id: 'u2', text: `${text}\n${text}\n${text}\n${text}\n${text}\n${text}`, images: [], open: true },
    { kind: 'header', id: 'h1', mood: 'stopped', open: false, label: text, tail: ` · ${text}` },
    { kind: 'header', id: 'h2', mood: 'running', open: true, label: text, tail: '' },
    { kind: 'title', id: 't1', text, failed: text, partial: true, hint: text },
    { kind: 'title', id: 't2', text, failed: text },
    { kind: 'reasoning', id: 'r1', label: text, pending: true },
    { kind: 'reasoning', id: 'r2', label: text, rows: [text, `${text}\n${text}`], earlier: text, more: text },
    { kind: 'answer', id: 'a1', text: `${text}\n\n${text}` },
    // The verbose tier: each state, with and without a target and an outcome, and the tool's body and its tail.
    { kind: 'tool', id: 'tl1', state: 'ok', name: text, target: text, outcome: text },
    { kind: 'tool', id: 'tl2', state: 'error', name: 'Bash', target: text, outcome: 'exit 1', body: [{ lead: '12', text, tone: 'danger' }, { lead: '⎿', text, tone: 'muted' }], moreBefore: text, more: text },
    { kind: 'tool', id: 'tl3', state: 'cancelled', name: text },
    { kind: 'tool', id: 'tl4', state: 'waiting', name: text, target: text },
    { kind: 'tool', id: 'tl5', state: 'returned', name: 'Edit', target: text },
    { kind: 'tool', id: 'tl6', state: 'pending', name: text, target: text, body: [{ text, tone: 'warning' }] },
    { kind: 'tool', id: 'tl7', state: 'pending', name: 'Read' },
    // The edit's diff: a stat with its bar in each direction, hunks with a tail, and a write's numbered code.
    { kind: 'tool', id: 'ed1', state: 'ok', name: 'Edit', target: text, stat: { added: 4, removed: 2 }, diff: [{ before: text, after: `${text}\n${text}`, language: 'ts', start: 10, maxRows: 2, tail: text }, { before: 'x', after: text, start: 90 }] },
    { kind: 'tool', id: 'ed2', state: 'ok', name: 'Edit', target: text, stat: { added: 0, removed: 9 } },
    { kind: 'tool', id: 'ed3', state: 'ok', name: 'Edit', target: text, stat: { added: 9, removed: 0 } },
    { kind: 'tool', id: 'wr1', state: 'ok', name: 'Write', target: text, stat: { added: 3, removed: 0 }, code: { text: `${text}\n${text}`, language: 'ts', start: 1 } },
    { kind: 'tool', id: 'md1', state: 'ok', name: 'ExitPlanMode', markdown: `${text}\n\n- ${text}` },
    // The standard tier: a run's head in each state, its calls, an opened call's body, and its `… +N more`.
    { kind: 'tools', id: 'g1', state: 'ok', name: text, head: text, items: [{ state: 'ok', label: text, outcome: text, body: [{ text, tone: 'muted' }], more: text }, { state: 'ok', label: text }] },
    { kind: 'tools', id: 'g2', state: 'partial', name: text, head: text, failed: `⚠ ${text}`, items: [{ state: 'error', label: text, outcome: text }, { state: 'ok', label: text, body: [{ lead: '3', text }] }] },
    { kind: 'tools', id: 'g3', state: 'pending', name: text, head: text, items: [{ state: 'pending', label: text }, { state: 'waiting', label: text, outcome: text }, { state: 'returned', label: text }, { state: 'cancelled', label: text }] },
    { kind: 'tools', id: 'g4', state: 'error', name: text, head: '', failed: text, items: [{ state: 'error', label: text }] },
    // The compaction row: running, settled, failed, the Compact level, a summary, and a manual `/compact` after its turn.
    { kind: 'compaction', id: 'c1', facts: compaction, hint: text, summary: [text, text], more: text },
    { kind: 'compaction', id: 'c2', facts: { state: 'ok', title: text, compact: false, change: text, tokens: text, trigger: text, bar: { from: 100, to: 100, drain: false, rev: 2 } } },
    { kind: 'compaction', id: 'c3', facts: { state: 'error', title: text, compact: true } },
    { kind: 'compaction', id: 'c4', facts: { state: 'ok', title: text, compact: true, change: text }, trailing: true },
    { kind: 'error', id: 'e1', text },
    { kind: 'interrupted', id: 'i1', text },
    { kind: 'note', id: 'n1', text },
  ]
}

/** The activity row of each phase, with the info line, the tip line, both empty, and a tail of counts. */
function activityFacts(text: string): ActivityFacts[] {
  const phases = ['diving', 'thinking', 'writing', 'tool', 'waiting', 'stopping'] as const
  return phases.flatMap((phase): ActivityFacts[] => [
    { phase, label: text, tail: [text, text] },
    { phase, label: text, labelTone: 'accent', labelStrong: true, tail: ['8s', '↑30.2k ↓1.1k', '38 tok/s'], info: text },
    { phase, label: text, tip: text },
    { phase, label: text, info: '' },
  ])
}

/** The notification line in each of its shapes: a notice at each severity, a chip, a hint, and the keys. */
function notificationFacts(text: string): (NotificationRowFacts | undefined)[] {
  return [
    undefined,
    { notice: { severity: 'success', message: text } },
    { notice: { severity: 'info', message: text, waiting: 2 } },
    { notice: { severity: 'warning', message: text, waiting: 1 } },
    { notice: { severity: 'error', message: text } },
    { chip: text },
    { chip: text, notice: { severity: 'error', message: text, waiting: 3 } },
    { hint: text },
    { keys: text, hint: text },
    { keys: text, notice: { severity: 'warning', message: text } },
  ]
}

/** The decision card of an approval (edit and command), a queue, a plan, and a zh label set. */
function decisionFacts(text: string): DecisionCardFacts[] {
  const options = [{ id: 'allow-once', label: text }, { id: 'allow-session', label: `${text} for this session` }, { id: 'reject', label: text }]
  return [
    { title: text, queue: `1 of 3 waiting ${text}`, options, note: { label: 'Feedback', placeholder: text }, keys: [{ id: 'open', semantic: 'external', label: text, hintLabel: text }] },
    { title: 'Decide', options, note: { label: 'Feedback', placeholder: 'type to explain…' }, keys: [{ id: 'open', semantic: 'external', label: 'Open command', hintLabel: 'open command' }] },
    { title: '决定', queue: '1 / 3 等待中', options: [{ id: 'allow-once', label: '允许一次' }, { id: 'reject', label: '拒绝' }], note: { label: '反馈', placeholder: '说明原因…' }, keys: [{ id: 'copy', semantic: 'copy', label: '复制计划', hintLabel: '复制计划' }] },
    { title: text, options: [{ id: 'approve', label: text }, { id: 'keep', label: 'Keep planning…' }], note: { label: 'Revise', placeholder: text }, keys: [{ id: 'copy', semantic: 'copy', label: text, hintLabel: text }, { id: 'open', semantic: 'external', label: 'Open plan', hintLabel: 'open plan' }] },
  ]
}

describe('components width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`TranscriptView rows survive ${name}`, () => {
      for (const width of WIDTHS) expectLinesFit(`TranscriptView/${name}`, renderStream(streamRows(text), width, text), width)
    })

    it(`ActivityRow survives ${name}`, () => {
      for (const facts of activityFacts(text)) {
        for (const width of WIDTHS) expectLinesFit(`ActivityRow/${facts.phase}/${name}`, render(ActivityRow(facts), width), width)
      }
    })

    it(`NotificationLine survives ${name}`, () => {
      for (const facts of notificationFacts(text)) {
        for (const width of WIDTHS) expectLinesFit(`NotificationLine/${name}`, render(NotificationLine(facts), width), width)
      }
    })

    it(`CompactionRow survives ${name}`, () => {
      const facts: CompactionFacts[] = [
        { state: 'running', title: text, compact: false, bar: { from: 40, to: 40, drain: false, rev: 1 }, progress: ['applying', text], percent: 40 },
        { state: 'running', title: text, compact: true, progress: [text] },
        { state: 'ok', title: text, compact: false, bar: { from: 40, to: 100, drain: true, rev: 2 }, change: text, tokens: text, trigger: 'auto' },
        { state: 'error', title: text, compact: false },
      ]
      for (const item of facts) {
        for (const width of WIDTHS) expectLinesFit(`CompactionRow/${item.state}/${name}`, render(CompactionRow(item), width), width)
      }
    })

    it(`DecisionCard survives ${name}`, () => {
      for (const facts of decisionFacts(text)) {
        for (const width of WIDTHS) expectLinesFit(`DecisionCard/${name}`, render(DecisionCard(facts), width), width)
      }
    })

    it(`SearchLine survives ${name}`, () => {
      const options = { prefix: '/', onChange: () => {}, onAccept: () => {}, onAbandon: () => {} } satisfies MayflySearchLineOptions
      const host = { colors: () => undefined, keymap: () => undefined, requestRender: () => {} }
      const search = new SearchLine(options, host)
      search.focused = true
      search.setStatus(text)
      for (const character of text) search.handleInput(character)
      for (const width of WIDTHS) expectLinesFit(`SearchLine/${name}`, search.render(width), width)
    })

    it(`selection band survives ${name}`, () => {
      const items: MayflyListItem[] = [{ id: 'a', label: text }, { id: 'b', label: text, under: 'a' }, { id: 'c', label: text }]
      const node = ui.list({ id: 'band', role: 'browse', marker: 'band', selectedIds: [], items })
      for (const width of WIDTHS) expectLinesFit(`SelectionBand/${name}`, render(node, width), width)
    })
  }

  it('the stream paints its rows (a scan of empty rows would pass for any width)', () => {
    const rows = renderStream(streamRows('probe'), 120, 'probe').join('\n')
    expect(rows).toContain('probe')
    expect(rows).toContain('+4')
  })
})
