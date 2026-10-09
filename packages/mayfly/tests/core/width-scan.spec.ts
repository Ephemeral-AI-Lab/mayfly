/**
 * The width-scan contract for core's own rendering surfaces (D48): the
 * gutter wrapper, the shared `framePanel` framer, `WrappingSelectList`
 * (the slash-command dropdown), the diff band painter, and the
 * `clampRowsToWidth` backstop itself — each must honor the `MayflyComponent` contract at every scan
 * width against every adversarial fixture.
 */

import { describe, expect, it } from 'vitest'
import type { SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import { clampRowsToWidth, framePanel } from '../../src/core/chrome.ts'
import { renderChartRows } from '../../src/core/chart-renderer.ts'
import { alignDiffLines, paintDiffRows } from '../../src/core/diff-align.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { renderListSegment } from '../../src/core/ui-patterns.ts'
import { GutterComponent } from '../../src/core/gutter.ts'
import { renderMermaidRows } from '../../src/core/rich-document.ts'
import { MayflyUiSurfaceRuntime, compileMayflyEditorShellNode, compileMayflyStatusNode, compileMayflyUiNode, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import type { MayflyUiImageSource } from '../../src/core/ui-images.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { ui } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents } from '../design/parity.ts'
import type { MayflyComponents, MayflyEditor, MayflySemanticColors } from '../../src/core/types.ts'
import { WrappingSelectList } from '../../src/core/wrapping-select-list.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ViewsLane } from '../../src/core/views-lane.ts'
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
    setBorderTitle: () => {},
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

    it(`truncating text and rich-text rows stay one fitting row over ${name}`, () => {
      const node = ui.stack.column([
        ui.text(`${text}\n${text}`, { tone: 'muted', overflow: 'truncate' }),
        ui.richText([{ text, tone: 'accent', styles: ['strong'] }, { text: `\t${text}` }], { overflow: 'truncate' }),
      ])
      const result = compileMayflyUiNode(node, {
        components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as never,
        colors: DARK_COLORS,
        getViewport: () => ({ columns: 80, rows: 20 }),
        screenMode: 'alternate',
        emit: () => {},
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      for (const width of SCAN_WIDTHS) {
        const rows = result.value.component.render(width)
        expect(rows).toHaveLength(2)
        expectLinesFit(`truncate/${name}`, rows, width)
      }
    })

    it(`image nodes stay fitting rows, as alt text and as an image, over ${name}`, () => {
      const ready: MayflyUiImageSource = { read: () => ({ state: 'ready', image: { data: new Uint8Array([1]), mediaType: 'image/png' } }) }
      const node = ui.stack.column([ui.image({ attachmentId: 'photo', alt: text, maxRows: 4 }), ui.image({ attachmentId: 'other', alt: `${text}\n${text}` })])
      const compile = (protocol: boolean, images: MayflyUiImageSource | undefined) => compileMayflyUiSurfaceNode(node, {
        components: {
          visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, imageProtocol: () => protocol,
          // Image protocol sequences have no visible width; the second row is the blank row an image reserves.
          createImage: () => ({ render: () => ['\x1b_Gf=100,a=T;AAAA\x1b\\', ''], invalidate: () => {} }),
        } as never,
        colors: DARK_COLORS,
        getViewport: () => ({ columns: 80, rows: 20 }),
        screenMode: 'alternate',
        emit: () => {},
        surfaceRuntime: new MayflyUiSurfaceRuntime(undefined, undefined, undefined, images),
      })
      const alt = compile(true, undefined)
      const drawn = compile(true, ready)
      expect(alt.ok && drawn.ok).toBe(true)
      if (!alt.ok || !drawn.ok) return
      for (const width of SCAN_WIDTHS) {
        const altRows = alt.value.component.render(width)
        expect(altRows).toHaveLength(2)
        expectLinesFit(`image-alt/${name}`, altRows, width)
        const imageRows = drawn.value.component.render(width)
        expect(imageRows).toHaveLength(4)
        expectLinesFit(`image/${name}`, imageRows, width)
      }
    })

    it(`prompts stay fitting rows in every state, over ${name}`, () => {
      const prompts = [
        ui.prompt({ id: 'p', value: text, tokens: [{ id: 't1', label: text.slice(0, 60), size: text.slice(0, 60) }, { id: 't2', label: 'notes.md', size: '2 KB' }], placeholder: [text.slice(0, 200), 'Ask'], symbol: '! ', symbolTone: 'accent' }),
        ui.prompt({ id: 'p', placeholder: [text.slice(0, 90), `${text.slice(0, 90)} · ${text.slice(0, 90)}`], completions: { items: [{ id: 'a', label: text.slice(0, 300), detail: text.slice(0, 300), right: text.slice(0, 60) }, { id: 'b', label: 'short' }] } }),
        ui.prompt({ id: 'p', recall: [{ kind: 'queued', text }, { kind: 'history', text: 'older' }], recallLabel: text.slice(0, 24), tokens: [{ id: 't', label: 'Image #1', size: '84 KB' }] }),
      ]
      for (const [index, prompt] of prompts.entries()) for (const width of SCAN_WIDTHS) {
        const surface = createRealSurface(ui.surface({ title: text, titleAlign: 'right', chrome: 'surface', hint: 'completions', child: prompt }), width, { components: parityComponents() })
        try {
          if (index === 1) surface.press('/')
          if (index === 2) { surface.press('\x1b[A'); surface.press('\x1b[A') }
          if (index === 0) surface.press('\x7f')
          const rows = surface.render()
          expect(rows.join('\n'), 'the prompt was admitted').not.toContain('could not be displayed')
          expectLinesFit(`prompt-${String(index)}/${name}`, rows, width)
        } finally { surface.dispose() }
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
      const horizontal = {
        kind: 'chart' as const,
        chart: 'bar' as const,
        layout: 'normalized' as const,
        orientation: 'horizontal' as const,
        categories: ['ctx', text],
        series: [
          { id: 'ok', label: text, tone: 'success' as const, values: [2, 4] },
          { id: 'failed', label: 'failed', tone: 'danger' as const, values: [1, 3] },
          { id: 'free', label: 'free', empty: true, values: [4, 2] },
        ],
      }
      const mermaid = `graph LR\n  A[${text}] --> B[done]`
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`Chart/${name}`, renderChartRows(chart, width, chartComponents, statusColors as MayflySemanticColors), width)
        expectLinesFit(`Chart-horizontal/${name}`, renderChartRows(horizontal, width, chartComponents, statusColors as MayflySemanticColors), width)
        const diagram = renderMermaidRows(mermaid, width)
        const documentRows = diagram ?? wrapTextWithAnsi(mermaid, Math.max(1, width))
        expectLinesFit(`Mermaid/${name}`, documentRows, width)
      }
    })

    it(`diff band painter survives ${name}`, () => {
      // Real SGR bands: padding must land exactly on the width, never past it.
      const ops = alignDiffLines(`keep\n${text}\nkeep`, `keep\nadded ${text}\nkeep`)
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`DiffBands/${name}`, paintDiffRows(ops, width, { visibleWidth, truncateToWidth }, DARK_COLORS), width)
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

    it(`form rows with headings, help, errors, marks, boxes, completions, and pickers survive ${name}`, () => {
      const long = text.slice(0, 120)
      const options = [{ id: 'a', label: long, disabled: true, disabledReason: long }, { id: 'b', label: long }, { id: 'c', label: 'tail' }]
      const node = ui.surface({ chrome: 'overlay', title: long, badges: [{ text: long.slice(0, 20), tone: 'muted' }], child: ui.stack.column([
        ui.form({ id: 'form', fields: [
          { kind: 'input', id: 'name', label: long.slice(0, 30), value: long, placeholder: long, group: long, help: long, required: true, pattern: '^x', patternMessage: long, suggestions: [long, 'xx'] },
          { kind: 'secret', id: 'key', label: 'Key', value: long, help: long },
          { kind: 'select', id: 'mode', label: 'Mode', value: 'b', origin: 'inherited', resetValue: 'c', group: 'Second', options },
          { kind: 'number', id: 'count', label: long.slice(0, 20), value: 12, min: 1, max: 99, unit: long.slice(0, 30), error: long },
          { kind: 'number', id: 'only-min', label: 'Min', value: 3, min: 1 },
          { kind: 'toggle', id: 'on', label: 'On', value: true, help: long },
          { kind: 'multiselect', id: 'many', label: 'Many', value: ['b', 'c'], options },
          { kind: 'textarea', id: 'notes', label: 'Notes', value: `${long}\n${long}`, help: long },
        ], submitActionId: 'save', submitLabel: long.slice(0, 40) }),
      ]) })
      const scanComponents = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, sliceByColumn, createEditor: () => scanEditor(long) } as never
      const model = new UiSurfaceModel('scan', { id: 'scan', revision: 0, node, source: [], scope: { kind: 'app', targetId: 'scan' }, update: { reason: 'replace' }, definition: {}, events: { prepare: async () => ({ reply: undefined, publish: () => false }) } })
      const surface = compileMayflyUiSurfaceNode(model.node!, { components: scanComponents, colors: statusColors as MayflySemanticColors, getViewport: () => ({ columns: 120, rows: 60 }), screenMode: 'alternate', emit: () => {}, contextHints: { enabled: true }, surfaceRuntime: new MayflyUiSurfaceRuntime(model) })
      if (!surface.ok) throw new Error(surface.message)
      const focus = surface.value.focusTarget!
      focus.focused = true
      const scan = (): void => { for (const width of SCAN_WIDTHS) expectLinesFit(`form/${name}`, surface.value.component.render(width), width) }
      scan()
      // Every field in turn: focused, then opened (edited, picked, or toggled), then closed again; an edit leaves the surface dirty.
      for (let field = 0; field < 8; field += 1) {
        scan()
        focus.handleInput?.('\r')
        scan()
        focus.handleInput?.('x')
        scan()
        focus.handleInput?.('\x1b')
        scan()
        focus.handleInput?.('\x1b[B')
      }
      scan()
    })

    it(`list rows with spans, bodies, wrapping, tree guides, rules, and a segment strip survive ${name}`, () => {
      const long = text.slice(0, 120)
      const node = ui.stack.column([
        ui.list({ id: 'rich', role: 'choose', mode: 'multiple', tree: true, maxRows: 6, selectedIds: ['c1'], items: [
          { id: 'p', label: long, labelSpans: [{ text: long, styles: ['strong'] }], right: [{ text: long.slice(0, 30), tone: 'muted' }], rightFocus: [{ text: long.slice(0, 30) }], expanded: true, body: long },
          { id: 'c1', label: long, parentId: 'p', detail: long, badge: long.slice(0, 20), meter: { value: 2, max: 4, width: 40 }, indent: 8 },
          { id: 'c2', label: long, parentId: 'p', wrap: true, wrapMax: 2, body: ui.stack.column([ui.text(long), ui.divider({ label: long })]), expanded: true },
          { id: 'rule', label: '', rule: long },
          { id: 'seg', label: long, segment: { label: long.slice(0, 40), inheritedId: 'b', options: [{ id: 'a', label: long.slice(0, 30) }, { id: 'b', label: 'default' }, { id: 'c', label: long.slice(0, 30) }] } },
          { id: 'gap', label: '', gap: true },
        ] }),
        ui.list({ id: 'filtered', role: 'browse', filterable: true, filterMode: 'slash', filter: long, selectedIds: [], items: [{ id: 'x', label: long, wrap: true }] }),
      ])
      const scanComponents = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, sliceByColumn, createEditor: () => scanEditor('') } as never
      const options = { components: scanComponents, colors: statusColors as MayflySemanticColors, getViewport: () => ({ columns: 120, rows: 30 }), screenMode: 'alternate' as const, emit: () => {} }
      const surface = compileMayflyUiNode(node, options)
      if (!surface.ok) throw new Error(surface.message)
      surface.value.focusTarget!.focused = true
      for (const key of [undefined, '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B']) {
        if (key !== undefined) surface.value.focusTarget!.handleInput?.(key)
        for (const width of SCAN_WIDTHS) expectLinesFit(`rich-list/${name}`, surface.value.component.render(width), width)
      }
    })
  }

  for (const { name, text } of ADVERSARIAL) {
    it(`views lane strip, rule, and panel survive ${name}`, () => {
      const lane = new ViewsLane()
      lane.bind({ colors: statusColors as MayflySemanticColors, focus: () => {}, release: () => {}, requestRender: () => {}, viewport: () => ({ columns: 120, rows: 30 }) })
      for (const [index, id] of ['agents', 'jobs', 'goal'].entries()) {
        const panel = { render: () => [text.slice(0, 90), text], invalidate: () => {}, focused: false, handleInput: () => {} }
        lane.register({ id, title: index === 0 ? text.slice(0, 50) : id, priority: index, summary: { node: { kind: 'text', content: text }, count: text.slice(0, 20) } }).setPanel(panel, panel)
      }
      for (const id of ['agents', 'jobs', 'goal']) {
        lane.enter(id)
        for (const width of SCAN_WIDTHS) expectLinesFit(`ViewsLane/${name}/${id}`, [...lane.panel(width)!], width)
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
