/** The width-scan contract for the tab rows of slice 1.5: the strip, the wizard, and the rail, focused or not, over every adversarial fixture. */
import { describe, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const identity = (text: string): string => text
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents

/** Paints a node at `width` in a viewport `columns` wide, with the surface focused or not. */
function paint(node: MayflyUiNode, width: number, columns: number, focused: boolean): string[] {
  const result = compileMayflyUiNode(node, { components, colors, getViewport: () => ({ columns, rows: 30 }), screenMode: 'alternate' })
  if (!result.ok) throw new Error(result.message)
  if (result.value.focusTarget !== null) result.value.focusTarget.focused = focused
  return result.value.component.render(width)
}

describe('tab width scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`survives ${name}`, () => {
      const items = [
        { id: 'a', label: text, group: text, count: 12 }, { id: 'b', label: text, clip: 'start' as const, group: text, count: text },
        { id: 'c', label: '你好', attention: true, group: 'Other' }, { id: 'd', label: 'D', disabled: true },
      ]
      const nodes: Record<string, MayflyUiNode> = {
        strip: ui.tabs({ id: 'strip', activeId: 'b', items }),
        'first strip': ui.tabs({ id: 'strip', activeId: 'a', items }),
        'last strip': ui.tabs({ id: 'strip', activeId: 'd', items }),
        wizard: ui.tabs({ id: 'wizard', mode: 'wizard', activeId: 'b', items }),
        rail: ui.tabs({ id: 'rail', orientation: 'vertical', activeId: 'b', items }),
        'rail in a surface': ui.surface({ title: text, chrome: 'overlay', child: ui.stack.row([
          ui.child(ui.tabs({ id: 'rail', orientation: 'vertical', activeId: 'a', items }), { basis: 24, shrink: 0 }), ui.child(ui.text(text), { grow: 1 }),
        ], { gap: 2 }) }),
      }
      for (const [label, node] of Object.entries(nodes)) {
        for (const width of SCAN_WIDTHS) for (const focused of [true, false]) {
          // The viewport that follows the width folds a rail into the strip; a wide viewport keeps the rail at every width.
          expectLinesFit(`${label}/${name}`, paint(node, width, width, focused), width)
          expectLinesFit(`${label}@120/${name}`, paint(node, width, 120, focused), width)
        }
      }
    })
  }
})
