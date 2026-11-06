/**
 * The width-scan contract for the transcript components (D48): the crash
 * family (#14/#15/#18) all lived here, so every content-rendering component
 * renders each adversarial fixture at each scan width and must honor the
 * `MayflyComponent` contract — every output line's visible width within the
 * width it was given. A red row here is a latent pi-tui width-guard crash
 * (before the D48 exit clamp) or a mayfly-overflow.log entry (after it);
 * either way the component gets fixed, not the harness.
 */

import { homedir } from 'node:os'
import { describe, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import type { MayflyWorkflowRun } from '../../src/hosts/host-contract.ts'
import { agentsPanel } from '../../src/app/panels/agents.ts'
import { workflowPanel } from '../../src/app/panels/workflow.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { composeBannerLines, shortenHome } from '../../src/transcript/banner-model.ts'
import { composeSplashLines } from '../../src/transcript/splash.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'

/** Identity colors satisfy MayflySemanticColors where consumed. */
const colors = COLORS as MayflySemanticColors

/** Compile one public wire node through the renderer used by mounted panes. */
function renderNode(node: MayflyUiNode, width: number): string[] {
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(),
    colors,
    getViewport: () => ({ columns: width, rows: 24 }),
    screenMode: 'main',
    emit: () => {},
  })
  return (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width)
}

describe('transcript width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`splash survives ${name}`, () => {
      const components = fakeMayflyComponents()
      for (const width of [1, ...SCAN_WIDTHS]) {
        expectLinesFit(`Splash/${name}`, composeSplashLines({
          colors, strong: value => components.strong(value),
          truncate: (value, target) => components.truncateToWidth(value, target, '…'),
          visibleWidth: value => components.visibleWidth(value),
        }, {
          version: text,
          labels: { slogan: text, recent: text, more: text, moreFocused: text, empty: text, emptyHint: text },
          recent: [{ id: 'scan', title: text, project: text, age: 'now', live: true }],
        }, width, 24), width)
      }
    })

    it(`workflow pane survives ${name}`, () => {
      const run = {
        id: 'width-run',
        name: text,
        phases: [{ title: text }],
        phasesSeen: [text],
        currentPhase: text,
        agents: [{ seq: 1, label: text, phase: text, childId: 'child' }],
        startedAt: 0,
        stopReason: undefined,
        endedAt: undefined,
        agentsStarted: undefined,
        attributed: true,
      }
      const node = workflowPanel([run as unknown as MayflyWorkflowRun], () => undefined, 1_000, interpolateLocaleMessage)
      if (node === null) throw new Error('workflow width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`WorkflowView/${name}`, renderNode(node, width), width)
      }
    })

    it(`agents view survives ${name}`, () => {
      const members = [{ callId: 'call', childId: 'child', label: text, state: 'running' as const, startedAt: 0 }, { callId: 'gone', label: text, state: 'failed' as const, startedAt: 0, endedAt: 1 }]
      const tree = [{ kind: 'child', id: 'child', currentTool: text, inputTokens: 48_000, outputTokens: 6_400, liveChars: 80 }] as never
      const node = agentsPanel(members, tree, () => undefined, 90_000, interpolateLocaleMessage)
      if (node === null) throw new Error('agents width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`AgentsView/${name}`, renderNode(node, width), width)
      }
    })

    it(`banner (composeBannerLines) survives ${name}`, () => {
      const components = fakeMayflyComponents()
      const content = {
        version: text,
        model: text,
        provider: 'p',
        cwd: shortenHome(text, homedir()),
      }
      const deps = {
        colors,
        strong: (value: string) => components.strong(value),
        truncate: (t: string, target: number) => components.truncateToWidth(t, target),
        visibleWidth: (t: string) => components.visibleWidth(t),
      }
      for (const width of SCAN_WIDTHS) expectLinesFit(`Banner/${name}`, composeBannerLines(deps, content, width), width)
    })
  }

})
