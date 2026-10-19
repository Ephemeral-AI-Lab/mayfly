/** The width-scan contract for the compose compositions over every adversarial fixture, focused or not. */
import { describe, it } from 'vitest'
import { compose, ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui/compile/ui-compiler.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/text/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents

function paint(node: MayflyUiNode, width: number, focused: boolean): string[] {
  const result = compileMayflyUiNode(node, { emit: () => {}, components, colors, getViewport: () => ({ columns: width, rows: 30 }), bounded: true })
  if (!result.ok) throw new Error(result.message)
  if (result.value.focusTarget !== null) result.value.focusTarget.focused = focused
  return result.value.component.render(width)
}

describe('composition width scan', () => {
  for (const { name, text: full } of ADVERSARIAL) {
    it(`survives ${name}`, () => {
      const text = full
      const items = [{ id: 'a', label: text, count: 3 }, { id: 'b', label: '你好', attention: true }]
      const list = ui.list({ id: 'l', role: 'browse', marker: 'selection', selectedIds: [], items: [{ id: 'x', label: text, detail: text, right: [{ text, tone: 'muted' }] }] })
      const nodes: Record<string, MayflyUiNode> = {
        decision: compose.decisionLane({
          title: text, badges: [{ text, tone: 'muted' }],
          choices: [{ id: 'keep', label: text }, { id: 'delete', label: text, detail: text }],
          note: { id: 'why', label: text, placeholder: text },
          keys: [{ id: 'copy', label: text, key: 'c', hintLabel: text }],
        }),
        'body decision': compose.decisionLane({ title: text, body: ui.stack.column([ui.text(text), ui.richText([{ text, tone: 'warning' }])]) }),
        rail: compose.panel({
          title: text, escapeLabel: 'close',
          body: compose.rail({ rail: { id: 'rail', activeId: 'a', items }, pages: { a: list, b: ui.text(text) }, separator: false }),
        }),
        'live rail': compose.panel({
          title: text, escapeLabel: 'close',
          body: compose.rail({ rail: { id: 'rail', activeId: 'a', items }, content: list, railWidth: 60, separator: false }),
        }),
        split: compose.browser({ list, detail: ui.fields([{ label: text, value: [{ text }] }]), separator: false }),
        status: compose.panel({
          title: text, escapeLabel: 'close',
          body: compose.statusPage({ tabs: { id: 'st', activeId: 'a', items }, rows: [{ label: text, value: [{ text, tone: 'warning' }] }], footer: ui.text(text) }),
        }),
        'paged status': compose.panel({
          title: text, escapeLabel: 'close',
          body: compose.statusPage({ tabs: { id: 'st', activeId: 'a', items }, pages: { a: ui.text(text), b: list } }),
        }),
      }
      for (const [label, node] of Object.entries(nodes)) {
        for (const width of SCAN_WIDTHS) for (const focused of [true, false]) expectLinesFit(`${label}/${name}`, paint(node, width, focused), width)
      }
    })
  }
})
