/**
 * The width-scan contract for core's own rendering surfaces (D48): the
 * gutter wrapper, the shared `framePanel` framer, `WrappingSelectList`
 * (the slash-command dropdown), and the `clampRowsToWidth` backstop
 * itself — each must honor the `MayflyComponent` contract at every scan
 * width against every adversarial fixture.
 */

import { describe, expect, it } from 'vitest'
import type { SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import { clampRowsToWidth, framePanel } from '../../src/core/chrome.ts'
import { renderChartRows } from '../../src/core/chart-renderer.ts'
import { renderListSegment } from '../../src/core/ui-patterns.ts'
import { GutterComponent } from '../../src/core/gutter.ts'
import { renderMermaidRows } from '../../src/core/rich-document.ts'
import { compileMayflyEditorShellNode, compileMayflyStatusNode, compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { ui } from '../../../ui/src/index.ts'
import type { MayflyComponents, MayflyEditor, MayflySemanticColors } from '../../src/core/types.ts'
import { WrappingSelectList } from '../../src/core/wrapping-select-list.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

/** Identity paints: the scan measures true columns, not bracket markers. */
const selectTheme: SelectListTheme = {
  selectedPrefix: text => text,
  selectedText: text => text,
  description: text => text,
  scrollInfo: text => text,
  noMatch: text => text,
}

/** W4a migration sweep: every integer width in the supported fixture range. */
const MIGRATION_WIDTHS = Array.from({ length: 119 }, (_, index) => index + 2)
const identity = (text: string): string => text
const statusColors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity })

function scanEditor(text: string): MayflyEditor {
  return {
    focused: false,
    disableSubmit: false,
    setSubmitBarrier: () => {},
    submit: () => {},
    isShowingAutocomplete: () => false,
    refreshAutocomplete: () => {},
    getText: () => text,
    setText: () => {},
    addToHistory: () => {},
    getHistory: () => [],
    setBorderColor: () => {},
    setPromptSymbol: () => {},
    setBorderLabel: () => {},
    setConnectedAbove: () => {},
    setGhostHint: () => {},
    setAutocompleteProvider: () => {},
    getExpandedText: () => text,
    renderContent: width => wrapTextWithAnsi(text, Math.max(1, width)),
    insertText: () => {},
    render: width => wrapTextWithAnsi(text, Math.max(1, width)),
    invalidate: () => {},
  }
}

describe('core width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`GutterComponent over an honest child survives ${name}`, () => {
      const child = {
        // An honest child honors the width it is given, floor included.
        render: (width: number): string[] => wrapTextWithAnsi(text, Math.max(1, width)),
        invalidate: (): void => {},
      }
      const gutter = new GutterComponent(child)
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`Gutter/${name}`, gutter.render(width), width)
      }
    })

    it(`framePanel survives ${name}`, () => {
      // framePanel's body rows arrive pre-budgeted by their callers (the
      // HelpOverlay/InfoPanel pattern); the scan feeds them the same way.
      const budget = (row: string, width: number): string => truncateToWidth(row, Math.max(1, width))
      for (const width of SCAN_WIDTHS) {
        const body = [budget(`  ${text}`, width), budget(text, width)]
        expectLinesFit(`framePanel/${name}`, framePanel(body, width, {
          title: text.slice(0, 20),
          titleHint: '· hint',
        }), width)
      }
    })

    it(`WrappingSelectList survives ${name}`, () => {
      const items: SelectItem[] = [
        { value: text, label: `/${text.slice(0, 30)}`, description: text },
        { value: 'short', label: '/short', description: 'fits' },
      ]
      const list = new WrappingSelectList(items, 5, selectTheme, {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 32,
      })
      for (const width of MIGRATION_WIDTHS) {
        expectLinesFit(`WrappingSelectList/${name}`, list.render(width), width)
      }
    })

    it(`canonical status compiler survives ${name}`, () => {
      const result = compileMayflyStatusNode({
        kind: 'stack',
        direction: 'row',
        gap: 1,
        children: [
          { node: { kind: 'rich-text', spans: [{ text, tone: 'accent', styles: ['strong'] }] }, grow: 1, shrink: 1 },
          { node: { kind: 'progress', label: text, value: 1, max: 3 }, basis: 12, shrink: 1 },
        ],
      }, {
        components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as never,
        colors: statusColors as never,
        getViewport: () => ({ columns: 80, rows: 3 }),
        screenMode: 'main',
        maxRows: 3,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      for (const width of SCAN_WIDTHS) {
        const rendered = result.value.component.renderStatus(width)
        expect(rendered.rows.length).toBeLessThanOrEqual(3)
        expectLinesFit(`status/${name}`, rendered.rows, width)
      }
    })

    it(`canonical editor shell checked render survives ${name}`, () => {
      const editor = scanEditor(text)
      const result = compileMayflyEditorShellNode({
        kind: 'stack',
        direction: 'column',
        children: [
          { node: { kind: 'rich-text', spans: [{ text, tone: 'accent', styles: ['strong'] }] } },
          { node: { kind: 'editor-control' } },
        ],
      }, {
        editor,
        components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as never,
        colors: statusColors as never,
        getViewport: () => ({ columns: 80, rows: 20 }),
        screenMode: 'main',
        emit: () => {},
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      for (const width of SCAN_WIDTHS) {
        const rendered = result.value.component.renderChecked(width, { dryRun: true })
        expect(rendered.runtimeFailure).toBeUndefined()
        expectLinesFit(`editor-shell/${name}`, rendered.rows, width)
      }
    })

    it(`rich document and chart adapters survive ${name}`, () => {
      const chartComponents = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as MayflyComponents
      const chart = {
        kind: 'chart' as const,
        chart: 'bar' as const,
        layout: 'stacked' as const,
        categories: ['first', text],
        series: [
          { id: 'ok', label: text, tone: 'success' as const, values: [2, 4] },
          { id: 'failed', label: 'failed', tone: 'danger' as const, values: [1, 3] },
        ],
      }
      const mermaid = `graph LR\n  A[${text}] --> B[done]`
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`Chart/${name}`, renderChartRows(chart, width, chartComponents, statusColors as MayflySemanticColors), width)
        const diagram = renderMermaidRows(mermaid, width)
        const documentRows = diagram ?? wrapTextWithAnsi(mermaid, Math.max(1, width))
        expectLinesFit(`Mermaid/${name}`, documentRows, width)
      }
    })

    it(`interaction reasons, labels, units, numbering, and decisions survive ${name}`, () => {
      const reason = text.slice(0, 200)
      const node = ui.stack.column([
        ui.form({ id: 'form', fields: [
          { kind: 'number', id: 'count', label: text.slice(0, 40), value: 12, unit: text.slice(0, 30) },
          { kind: 'select', id: 'mode', label: 'Mode', value: null, options: [{ id: 'a', label: text.slice(0, 50) }] },
        ], submitActionId: 'save', submitLabel: text.slice(0, 60), cancelActionId: 'close', cancelLabel: 'Cancel' }),
        ui.list({ id: 'rows', role: 'choose', numbered: true, selectedIds: [], items: [
          { id: 'a', label: text.slice(0, 60), unavailableActions: { stop: reason } },
          { id: 'b', label: 'Disabled', disabled: true, disabledReason: reason },
          ...Array.from({ length: 9 }, (_, index) => ({ id: `n${String(index)}`, label: `row ${String(index)}` })),
        ] }),
        ui.actions({ id: 'actions', items: [
          { id: 'stop', label: 'Stop', selections: [{ pagePath: [], controlId: 'rows' }], confirm: { title: text.slice(0, 80), detail: reason, confirmLabel: text.slice(0, 20), tone: 'danger' } },
          { id: 'off', label: 'Off', disabled: true, disabledReason: reason },
        ] }),
      ])
      const model = new UiSurfaceModel('scan', { id: 'scan', revision: 0, node, source: [], scope: { kind: 'app', targetId: 'scan' }, update: { reason: 'replace' }, definition: {}, events: { prepare: async () => ({ reply: undefined, publish: () => false }) } })
      const scanComponents = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, createEditor: () => scanEditor('') } as never
      const options = { components: scanComponents, colors: statusColors as MayflySemanticColors, getViewport: () => ({ columns: 120, rows: 30 }), screenMode: 'alternate' as const, emit: () => {} }
      const surface = compileMayflyUiNode(model.node, { ...options, interaction: model })
      if (!surface.ok) throw new Error(surface.message)
      model.updateChoice({ pagePath: [], controlId: 'rows' }, { kind: 'focus', id: 'n0' })
      model.invoke('stop')
      const decision = compileMayflyUiNode(model.decisionNode, { ...options, interaction: model })
      if (!decision.ok) throw new Error(decision.message)
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`interaction-surface/${name}`, surface.value.component.render(width), width)
        expectLinesFit(`decision/${name}`, decision.value.component.render(width), width)
      }
    })

    it(`list-row segment strip survives ${name}`, () => {
      const segment = {
        label: text.slice(0, 80),
        selectedId: 'b',
        options: [
          { id: 'a', label: text.slice(0, 60) },
          { id: 'b', label: `selected ${text.slice(0, 40)}` },
          { id: 'c', label: 'tail option' },
        ],
      }
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`ListSegment/${name}`, [renderListSegment(segment, 'b', width, statusColors as MayflySemanticColors)], width)
        expectLinesFit(`ListSegment-none/${name}`, [renderListSegment(segment, undefined, width, statusColors as MayflySemanticColors)], width)
      }
    })
  }

  it('clampRowsToWidth passes fits through untouched and cuts the rest', () => {
    const truncate = (t: string, w: number): string => (t.length <= w ? t : `${t.slice(0, Math.max(0, w - 3))}...`)
    const rows = ['fits', 'an over-wide row that must be cut']
    expect(clampRowsToWidth(['fits'], 10, truncate)).toEqual(['fits'])
    expect(clampRowsToWidth(rows, 12, truncate)).toEqual(['fits', 'an over-w...'])
  })
})
