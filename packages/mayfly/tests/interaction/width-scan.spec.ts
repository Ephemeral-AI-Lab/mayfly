/**
 * The width-scan contract for the interaction panels (D48): every
 * content-rendering panel renders each adversarial fixture at each scan
 * width and must honor the `MayflyComponent` contract — every output line's
 * visible width within the width it was given. A red row here is a latent
 * pi-tui width-guard crash (before the D48 exit clamp) or a
 * mayfly-overflow.log entry (after it). The plugin-boot components (mode
 * status, pane queue, approval, editor-plus echo) render through these
 * same panel primitives and carry their own real-semantics width
 * assertions in their specs.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { helpNode } from '../../src/interaction/help.ts'
import { renamePanelModel } from '../../src/interaction/rename-model.ts'
import { agentsPanelModel } from '../../src/interaction/agents-model.ts'
import { tracePanelModel } from '../../src/interaction/trace-model.ts'
import { createRealSurface, probeComponents } from '../design/probe.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { helpCatalogSections } from './help-catalog-fixture.ts'
import { plain } from '../helpers.ts'

describe('interaction width-scan', () => {
  for (const [width, height] of [[120, 40], [40, 16]] as const) {
    it(`complete Help catalog admits, pages to its last command, and restores the top at ${width}x${height}`, () => {
      const surface = createRealSurface(helpNode(helpCatalogSections()), width, {
        components: probeComponents(),
        overrides: { getViewport: () => ({ columns: width, rows: height }) },
      })
      const assertFrame = (rows: string[]): string => {
        expectLinesFit(`complete-help/${width}x${height}`, rows, width)
        expect(rows.length).toBeLessThanOrEqual(height)
        return plain(rows).join('\n')
      }
      try {
        expect(assertFrame(surface.render())).toContain('Commands')
        expect(assertFrame(surface.render())).toContain('/agents')
        let bottom = ''
        for (let page = 0; page < 100 && !bottom.includes('/onboarding'); page += 1) {
          bottom = assertFrame(surface.press('\x1b[6~'))
        }
        expect(bottom).toContain('/onboarding')
        expect(assertFrame(surface.press('\x1b[H'))).toContain('Commands')
        expect(assertFrame(surface.press('\x1b[F'))).toContain('/onboarding')
        expect(assertFrame(surface.press('\x1b[H'))).toContain('/agents')
      } finally { surface.dispose() }
    })
  }

  for (const { name, text } of ADVERSARIAL) {
    it(`Subagent tree and its stop confirmation survive ${name}`, () => {
      const entries = [
        { kind: 'child' as const, id: SessionId('branch'), parentId: SessionId('root'), depth: 1, hasChildren: true, mode: 'continuable' as const, activity: 'running' as const, label: text, tokens: 2048, toolCount: 3, activeSince: 0 },
        { kind: 'child' as const, id: SessionId('nested'), parentId: SessionId('branch'), depth: 2, hasChildren: false, mode: 'one-shot' as const, activity: 'inactive' as const, label: text, stopBlocked: text },
        { kind: 'diagnostic' as const, id: SessionId('diagnostic'), parentId: SessionId('branch'), depth: 2, reason: 'corrupt' as const },
      ]
      for (const width of SCAN_WIDTHS) {
        const surface = createRealSurface(agentsPanelModel(entries, 65_000, interpolateLocaleMessage), width, { components: probeComponents() })
        try {
          expectLinesFit(`agents/${name}`, surface.render(), width)
          const confirmation = surface.press('x')
          expectLinesFit(`agents-stop/${name}`, confirmation, width)
        } finally { surface.dispose() }
      }
    })
    it(`Rename title editor survives ${name}`, () => {
      for (const width of SCAN_WIDTHS) {
        const surface = createRealSurface(renamePanelModel(text), width, { components: probeComponents() })
        try { expectLinesFit(`rename/${name}`, surface.render(), width) } finally { surface.dispose() }
      }
    })
    it(`Trace list and detail survive ${name}`, () => {
      const item = { seq: 1, lastSeq: 2, eventSeqs: [1, 2], time: 1_000, type: 'assistant/attempt', surface: 'current' as const, title: text, summary: text }
      for (const narrow of ['list', 'detail'] as const) for (const width of SCAN_WIDTHS) {
        const surface = createRealSurface(tracePanelModel(text, [item], undefined, { selected: item, document: JSON.stringify({ native: text }), narrow, escapeLabel: 'back' }), width, { components: probeComponents() })
        try { expectLinesFit(`trace-${narrow}/${name}`, surface.render(), width) } finally { surface.dispose() }
      }
    })
  }
})
