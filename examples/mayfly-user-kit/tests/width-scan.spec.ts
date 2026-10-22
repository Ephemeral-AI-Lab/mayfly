/** Canonical compiler width scans for the shared kit and direct examples.
 * @module @mayfly-example/user-kit/tests/width-scan
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyApi, type MayflyUiNode } from '../../../packages/ui/src/provider.ts'
import { MayflyComponentsService } from '../../../packages/mayfly/src/core/components.ts'
import { DARK_COLORS } from '../../../packages/mayfly/src/core/theme-dark.ts'
import { compileMayflyUiNode } from '../../../packages/mayfly/src/core/ui-compiler.ts'
import { ADVERSARIAL, expectLinesFit, SCAN_WIDTHS } from '../../../packages/mayfly/tests/core/width-scan.ts'
import { ui } from '../../../packages/ui/src/index.ts'
import * as bottomLog from '../../bottom-log/src/index.ts'
import * as header from '../../header/src/index.ts'
import { overlayRequest } from '../../overlay/src/index.ts'
import * as inspector from '../../right-inspector/src/index.ts'
import * as uiGallery from '../../ui-gallery/src/index.ts'
import { summaryMetric } from '../src/index.ts'

const components = new MayflyComponentsService(new Context(), { theme: { colors: DARK_COLORS }, tui: {} as never })

function uiRows(name: string, node: MayflyUiNode): void {
  const viewport = { columns: 120, rows: 20 }
  const result = compileMayflyUiNode(node, {
    components, colors: DARK_COLORS, getViewport: () => viewport, screenMode: 'alternate', emit: () => {},
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  for (const width of SCAN_WIDTHS) {
    viewport.columns = width
    expectLinesFit(name, result.value.component.render(width), width)
  }
}

describe('example width contracts', () => {
  it('scans every direct pane and the overlay through the canonical compiler', async () => {
    const ctx = new Context()
    await ctx.plugin({ name: 'example-width-api', apply: applyApi })
    try {
      for (const plugin of [header, inspector, bottomLog, uiGallery]) await ctx.plugin(plugin)
      expect(ctx.mayflyPanes.list()).toHaveLength(4)
      for (const entry of ctx.mayflyPanes.list()) {
        const node = entry.node
        expect(node).not.toBeNull()
        uiRows(entry.id, node!)
      }
      uiRows('example.overlay.details', ui.surface({
        chrome: 'overlay',
        title: overlayRequest.title,
        padding: 1,
        child: overlayRequest.node,
      }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scans adversarial shared-kit content at every repository width', () => {
    for (const fixture of ADVERSARIAL) {
      uiRows(`user-kit:${fixture.name}`, summaryMetric.render({
        label: fixture.text,
        value: fixture.text,
        detail: fixture.text,
      }))
    }
  })
})
