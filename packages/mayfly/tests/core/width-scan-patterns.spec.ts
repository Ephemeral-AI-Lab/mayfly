/** The width-scan contract for the four patterns of slice 1.8b over every adversarial fixture, focused or not. */
import { describe, it } from 'vitest'
import { patterns, ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const identity = (text: string): string => text
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents

function paint(node: MayflyUiNode, width: number, focused: boolean): string[] {
  const result = compileMayflyUiNode(node, { components, colors, getViewport: () => ({ columns: width, rows: 30 }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  if (result.value.focusTarget !== null) result.value.focusTarget.focused = focused
  return result.value.component.render(width)
}

describe('pattern width scan', () => {
  for (const { name, text: full } of ADVERSARIAL) {
    it(`survives ${name}`, () => {
      // A tree admits 20000 characters of text in all; the longest fixture is cut so a pattern that repeats it stays under it.
      const text = full.slice(0, 400)
      const items = [{ id: 'a', label: text, count: 3 }, { id: 'b', label: '你好', attention: true }]
      const list = ui.list({ id: 'l', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'x', label: text, detail: text, right: [{ text, tone: 'muted' }] }] })
      const nodes: Record<string, MayflyUiNode> = {
        decision: patterns.decisionPanel({
          title: text, badges: [{ text, tone: 'muted' }], preview: [ui.text(text), ui.richText([{ text, tone: 'warning' }])],
          options: [{ id: 'keep', label: text }, { id: 'delete', label: text, detail: text }], input: { id: 'why', label: text, placeholder: text },
          accelerators: [{ id: 'copy', label: text, key: 'c', hintLabel: text }],
        }),
        'instant decision': patterns.decisionPanel({ title: text, instant: true, options: [{ id: 'a', label: text }] }),
        rail: patterns.railPanel({ title: text, rail: { id: 'rail', activeId: 'a', items }, content: { a: list, b: ui.text(text) } }),
        'live rail': patterns.railPanel({ title: text, rail: { id: 'rail', activeId: 'a', items }, content: list, railWidth: 60 }),
        split: patterns.splitView({ list, detail: ui.fields([{ label: text, value: [{ text }] }]) }),
        status: patterns.statusPage({ title: text, tabs: { id: 'st', activeId: 'a', items }, rows: [{ label: text, value: [{ text, tone: 'warning' }] }], footer: ui.text(text) }),
        'paged status': patterns.statusPage({ title: text, tabs: { id: 'st', activeId: 'a', items }, pages: { a: ui.text(text), b: list } }),
      }
      for (const [label, node] of Object.entries(nodes)) {
        for (const width of SCAN_WIDTHS) for (const focused of [true, false]) expectLinesFit(`${label}/${name}`, paint(node, width, focused), width)
      }
    })
  }
})
