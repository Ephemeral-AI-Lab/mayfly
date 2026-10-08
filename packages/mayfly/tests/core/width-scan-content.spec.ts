/** The width-scan contract for the content, layout, and motion rows of slice 1.3, over every adversarial fixture. */
import { describe, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const identity = (text: string): string => text
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents

function paint(node: MayflyUiNode, width: number): string[] {
  const result = compileMayflyUiNode(node, { components, colors, getViewport: () => ({ columns: width, rows: 30 }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

describe('content, layout, and motion width scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`survives ${name}`, () => {
      const nodes: Record<string, MayflyUiNode> = {
        'middle text': ui.text(text, { overflow: 'middle', styles: ['strong'] }),
        'start text': ui.text(text, { overflow: 'start' }),
        fields: ui.fields([{ label: text, value: [{ text }] }, { label: '', value: [{ text: 'x' }] }]),
        sections: ui.sections([{ title: text, body: ui.text(text) }, { title: text, collapsed: true, body: ui.text('x') }]),
        'numbered code': ui.code(`${text}\n${text}`, { numbered: true, language: 'ts' }),
        diff: ui.diff(`a\n${text}`, `a\n${text}!`, { start: 9000, hunkHeader: true, context: 3, maxRows: 2 }),
        loader: ui.loader({ message: text, variant: 'breath', elapsedMs: 4_000_000, cancelActionId: 'stop', cancelLabel: text }),
        cells: ui.progress({ label: text, value: 3, max: 7, style: 'cells', width: 30, showPercent: true }),
        rule: ui.progress({ style: 'rule', value: 3, max: 7, width: 80, tone: 'danger' }),
        bar: ui.progress({ label: text, value: 3, max: 7, showPercent: true }),
        divider: ui.divider({ label: text }),
        'motion row': ui.richText([{ text: '', motion: 'loader', variant: 'bloom' }, { text }]),
        shimmer: ui.richText([{ text, motion: 'shimmer' }], { overflow: 'truncate' }),
        'title right': ui.surface({ title: text, titleAlign: 'right', chrome: 'overlay', border: 'warning', badges: [{ text }], child: ui.text(text) }),
        region: ui.scroll(ui.stack.column([ui.text(text), ui.text(text)]), { id: 'log', height: 3, fit: true, pill: true, follow: 'end' }),
        heatmap: ui.chart({ chart: 'heatmap', cell: 1, columns: ['a', 'b'], columnLabels: [text, ''], rows: [text], values: [[0, 1]], levels: [{ value: 0, label: text }, { value: 1, label: 'x' }] }),
        sparkline: ui.chart({ chart: 'sparkline', values: [1, 2, 3], label: text }),
      }
      for (const [label, node] of Object.entries(nodes)) {
        for (const width of SCAN_WIDTHS) expectLinesFit(`${label}/${name}`, paint(node, width), width)
      }
    })
  }
})
