/**
 * Branch-focused decisions of core widgets whose remaining paths the feature
 * specs do not reach: overlapping inline tokens, hand-built diff rows and
 * syntax literals, the column chart's axis rounding and zero-share guard, the
 * chart formatter's compact/x-label forms, the scrollbar's timer and columns,
 * and a typed choice row.
 *
 * @module @ephemeral-ai/mayfly/tests/core/coverage-c7-core
 */

import type { Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { paintTokenRows } from '../../src/core/editor-tokens.ts'
import { diffModel, paintDiffSegment, type DiffSegment } from '../../src/core/diff-align.ts'
import { renderColumns } from '../../src/core/chart-columns.ts'
import { renderChartRows } from '../../src/core/chart-renderer.ts'
import { createChoiceState, reconcileChoice, reduceChoice } from '../../src/core/ui-interaction-choice.ts'
import { BarVisibility, BarredScrollView } from '../../src/core/ui-scroll-region.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()
const components = { visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as MayflyComponents
const paints = { label: (text: string): string => `<L>${text}</L>`, detail: (text: string): string => `<D>${text}</D>` }
const CURSOR = '\x1b[7m \x1b[0m'

describe('inline token overlap', () => {
  it('leaves an occurrence inside an earlier token plain instead of painting it twice', () => {
    const rows = ['> [image #1 84 KB]']
    const painted = paintTokenRows(rows, [{ text: '[image #1 84 KB]', kind: 'image' }, { text: 'image #1', kind: 'image' }], undefined, paints, CURSOR)
    // The first token paints the whole marker; the nested occurrence is skipped by the overlap guard.
    expect(painted[0]).toBe('> <D>[</D><L>image #1</L><D> 84 KB]</D>')
  })

  it('uses the cursor-row occurrence for a selected token and the last one when the cursor is elsewhere', () => {
    const rows = [`> ${CURSOR}`, '> @src/a.ts']
    const painted = paintTokenRows(rows, [{ text: '@src/a.ts', kind: 'mention' }], 0, paints, CURSOR)
    // The selected token's only occurrence is on the other row, so the last one is chosen and drawn inverse.
    expect(painted[1]).toContain('\x1b[7m@src/a.ts\x1b[27m')
  })
})

describe('diff rows beyond the model', () => {
  const helpers = { truncateToWidth, visibleWidth }
  const palette = {
    text: (text: string): string => `<T>${text}</T>`,
    muted: (text: string): string => `<G>${text}</G>`,
    diffAdded: (text: string): string => `<A>${text}</A>`,
    diffRemoved: (text: string): string => `<R>${text}</R>`,
    diffAddedBg: (text: string): string => text,
    diffRemovedBg: (text: string): string => text,
    diffMeta: (text: string): string => text,
  }
  const style = (lit?: { readonly before: readonly string[], readonly after: readonly string[] }) => ({
    numbered: true, start: 1, beforeStart: 1, ...lit === undefined ? {} : { lit },
  })

  it('paints the highlighted side text, expands tabs, and falls back to the plain row when a literal is absent', () => {
    const segment: DiffSegment = { kind: 'rows', rows: [
      { old: 1, sign: '-', text: 'before\trow' },
      { new: 1, sign: '+', text: 'after row' },
      { old: 2, new: 2, sign: '', text: 'context' },
    ] }
    const rows = paintDiffSegment(segment, 1, 80, helpers, palette, style({ before: ['<X>BEFORE</X>'], after: ['<Y>AFTER</Y>'] }))
    expect(rows[0]).toContain('<X>BEFORE</X>')
    expect(rows[1]).toContain('<Y>AFTER</Y>')
    // The context row has no literal on its side and paints the plain text.
    expect(rows[2]).toContain('<T>context</T>')
  })

  it('numbers a hand-built row whose side number is absent without throwing', () => {
    const segment: DiffSegment = { kind: 'rows', rows: [
      { sign: '-', text: 'old' },
      { sign: '+', text: 'new' },
    ] }
    const rows = paintDiffSegment(segment, 1, 40, helpers, palette, style({ before: ['BEFORE'], after: ['AFTER'] }))
    // The gutter pads an empty number; the literal indexes from the absent number's zero.
    expect(rows[0]).toContain('<G>  │</G>')
    expect(rows[1]).toContain('<A>new</A>')
  })

  it('rounds the axis to 1, 2, 2.5, 5, and 10 across the boundaries', () => {
    const axisTop = (value: number): string => {
      const rows = renderColumns(ui.chart({ chart: 'bar', categories: ['a'], series: [{ id: 's', values: [value] }] }) as never, 40, components, colors)!
      return rows[0]!.split('┤')[0]!.trim()
    }
    expect(axisTop(0.5)).toBe('0.5')
    expect(axisTop(1)).toBe('1')
    expect(axisTop(1.5)).toBe('2')
    expect(axisTop(2.2)).toBe('2.5')
    expect(axisTop(3)).toBe('5')
    expect(axisTop(7)).toBe('10')
  })

  it('refuses a plot narrower than one group of series', () => {
    const crowded = ui.chart({ chart: 'bar', categories: ['a'], series: Array.from({ length: 12 }, (_, index) => ({ id: `s${String(index)}`, values: [1] })) })
    expect(renderColumns(crowded as never, 12, components, colors)).toBeUndefined()
  })

  it('keeps a zero-share stacked series out of the top colour', () => {
    const stacked = ui.chart({ chart: 'bar', layout: 'stacked', height: 3, categories: ['a'], series: [
      { id: 'empty', tone: 'muted', values: [0] },
      { id: 'full', tone: 'success', values: [4] },
    ] })
    const rows = renderColumns(stacked as never, 40, components, { ...colors, success: (text: string) => `[S]${text}[/S]`, muted: (text: string) => `[M]${text}[/M]` })
    expect(rows!.join('\n')).toContain('[S]█')
  })

  it('draws an all-zero normalized chart as empty tracks, like a zero total', () => {
    const zero = ui.chart({ chart: 'bar', layout: 'normalized', height: 3, categories: ['a', 'b'], series: [
      { id: 'a', values: [0, 0] },
      { id: 'b', values: [0, 0] },
    ] })
    const rows = renderColumns(zero as never, 40, components, colors)
    expect(rows).toBeDefined()
    expect(rows!.every(row => visibleWidth(row) <= 40)).toBe(true)
  })
})

describe('chart formatter forms', () => {
  it('formats compact and scaled y ticks for a plotted line', () => {
    const compact = renderChartRows(ui.chart({ chart: 'line', height: 6, yFormat: 'compact', series: [
      { id: 'a', points: [{ x: 0, y: 20 }, { x: 1, y: 40 }, { x: 2, y: 60 }] },
    ] }), 80, components, colors)
    expect(compact.length).toBeGreaterThan(0)
    expect(compact.every(row => visibleWidth(row) <= 80)).toBe(true)

    // Below ten the plot scales by ten; the non-compact formatter reports the scaled value back.
    const scaled = renderChartRows(ui.chart({ chart: 'line', height: 6, series: [
      { id: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] },
    ] }), 80, components, colors)
    expect(scaled.length).toBeGreaterThan(0)
    expect(scaled.every(row => visibleWidth(row) <= 80)).toBe(true)
  })

  it('names x ticks from xLabels and tolerates an empty label list', () => {
    const labelled = renderChartRows(ui.chart({ chart: 'line', height: 6, xLabels: ['zero', 'one', 'two'], series: [
      { id: 'a', points: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 30 }] },
    ] }), 80, components, colors)
    expect(labelled.join('\n')).toContain('zero')
    const empty = renderChartRows(ui.chart({ chart: 'line', height: 6, xLabels: [], series: [
      { id: 'a', points: [{ x: 0, y: 10 }, { x: 1, y: 20 }] },
    ] }), 80, components, colors)
    expect(empty.length).toBeGreaterThan(0)
    expect(empty.every(row => visibleWidth(row) <= 80)).toBe(true)
  })
})

describe('scroll bar visibility and columns', () => {
  it('drops a live linger timer when focus leaves the gated scroll', () => {
    vi.useFakeTimers()
    try {
      const repaint = vi.fn()
      const bar = new BarVisibility(true, repaint)
      bar.focus(true)
      bar.moved()
      expect(bar.visible).toBe(true)
      bar.focus(false)
      expect(bar.visible).toBe(false)
      vi.advanceTimersByTime(2_000)
      expect(repaint).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a move while an unfocused gated scroll is idle', () => {
    const repaint = vi.fn()
    const bar = new BarVisibility(true, repaint)
    bar.moved()
    expect(bar.visible).toBe(false)
  })

  it('keeps the bar columns only for a barred view and paints the track while it lingers', () => {
    const child: Component = { render: () => ['a', 'b', 'c', 'd', 'e'], invalidate: () => {} }
    const plain = new BarredScrollView(child, { scrollbar: false, colors: () => undefined, focusGated: false, repaint: () => {} })
    expect(plain.barColumns).toBe(0)
    const barred = new BarredScrollView(child, { scrollbar: true, colors: () => undefined, focusGated: false, repaint: () => {} })
    expect(barred.barColumns).toBe(2)
    expect(barred.isScrollbarVisible).toBe(false)
    barred.updateLayout(10, 3, () => {})
    expect(barred.isScrollbarVisible).toBe(false)
    // While the bar is not drawn the kept columns pad with the gap.
    expect(barred.render(20).every(row => visibleWidth(row) <= 20)).toBe(true)
    barred.scrollBy(2)
    expect(barred.isScrollbarVisible).toBe(true)
    const rows = barred.render(20)
    expect(rows.join('\n')).toContain('░')
    // The content keeps its whole width: the bar's columns live inside the painted rows.
    expect(rows.every(row => visibleWidth(row) <= 20)).toBe(true)
    // An image row is passed through untouched instead of being padded to the bar.
    const imageChild: Component = { render: () => ['\x1b_Gfake'], invalidate: () => {} }
    const imageView = new BarredScrollView(imageChild, { scrollbar: true, colors: () => undefined, focusGated: false, repaint: () => {} })
    imageView.updateLayout(1, 1, () => {})
    expect(imageView.render(20)[0]).toBe('\x1b_Gfake')
  })
})

describe('typed choice rows', () => {
  const typed = ui.list({ id: 'answers', role: 'choose', mode: 'multiple', selectedIds: [], items: [
    { id: 'a', label: 'A', input: {} },
    { id: 'b', label: 'B', input: {} },
    { id: 'plain', label: 'Plain' },
    { id: 'off', label: 'Disabled', input: {}, disabled: true },
  ] })

  it('stores text, selects the row, and drops its draft on empty', () => {
    let state = createChoiceState(typed)
    state = reduceChoice(state, { kind: 'input', id: 'a', text: 'hello' })
    expect(state).toMatchObject({ inputs: { a: 'hello' }, selectedIds: ['a'], dirty: true })
    // Repeating the same text is no change.
    expect(reduceChoice(state, { kind: 'input', id: 'a', text: 'hello' })).toBe(state)
    state = reduceChoice(state, { kind: 'input', id: 'b', text: 'world' })
    expect(state.selectedIds).toEqual(['a', 'b'])
    state = reduceChoice(state, { kind: 'input', id: 'a', text: '' })
    expect(state.inputs).toEqual({ b: 'world' })
    expect(state.selectedIds).toEqual(['b'])
    expect(state.dirty).toBe(true)
  })

  it('refuses a row without an input, a disabled one, a missing one, and a browse list', () => {
    const state = createChoiceState(typed)
    expect(reduceChoice(state, { kind: 'input', id: 'plain', text: 'x' })).toBe(state)
    expect(reduceChoice(state, { kind: 'input', id: 'off', text: 'x' })).toBe(state)
    expect(reduceChoice(state, { kind: 'input', id: 'missing', text: 'x' })).toBe(state)
    const browse = createChoiceState({ ...typed, role: 'browse' })
    expect(reduceChoice(browse, { kind: 'input', id: 'a', text: 'x' })).toBe(browse)
    // A legacy state without an input map still freezes into one when a later edit lands.
    const { inputs: _inputs, ...legacy } = createChoiceState(typed)
    expect(reduceChoice(legacy, { kind: 'query', query: '' }).inputs).toBeUndefined()
    expect(reduceChoice(legacy, { kind: 'input', id: 'a', text: 'x' })).toMatchObject({ inputs: { a: 'x' } })
    // Reconciling a legacy state rebuilds the input map from its absent one.
    const reconciled = reconcileChoice(legacy, ui.list({ ...typed, id: 'answers-next' }))
    expect(reconciled.inputs).toEqual({})
  })
})

describe('diff model gap traversal', () => {
  it('counts a skipped run as one gap row over context-only lines', () => {
    const ops = [
      { type: 'ctx' as const, text: 'a' },
      { type: 'del' as const, text: 'b' },
      { type: 'ctx' as const, text: 'c' },
      { type: 'ctx' as const, text: 'd' },
      { type: 'add' as const, text: 'e' },
    ]
    const model = diffModel(ops, { context: 0 })
    expect(model.segments.filter(segment => segment.kind === 'gap')).toHaveLength(2)
  })
})
