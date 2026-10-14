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
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GoalProjection } from '@deepseek-ai/dsh-goal'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import * as activityPane from '../../src/transcript/pane-activity.ts'
import * as agentsPane from '../../src/transcript/pane-agents.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import * as todoPane from '../../src/transcript/pane-todo.ts'
import { workflowNode, type WorkflowRunState } from '../../src/transcript/pane-workflow.ts'
import { goalStatusText } from '../../src/transcript/status-goal.ts'
import { StatusFooterComponent } from '../../src/transcript/status-model.ts'
import { bannerLayout, composeBannerLines, shortenHome } from '../../src/transcript/banner.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { bootPanePlugin } from './pane-fakes.ts'
import { COLORS, fakeAgent } from './status-fakes.ts'
import { event, subagentCallEvent } from './helpers.ts'
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
      } satisfies WorkflowRunState
      const node = workflowNode([run], 1_000)
      if (node === null) throw new Error('workflow width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`WorkflowPane/${name}`, renderNode(node, width), width)
      }
    })

    it(`agents pane survives ${name}`, async () => {
      agentsPane.setPaneAgentsClock(() => 2_000)
      const harness = await bootPanePlugin(agentsPane, fakeAgent([
        subagentCallEvent(1, 1, 'width-agent', 'subagent', text, text, { time: 1_000 }),
      ]))
      try {
        for (const width of SCAN_WIDTHS) {
          expectLinesFit(`AgentsPane/${name}`, harness.screen.paneLines(width), width)
        }
      } finally {
        await harness.dispose()
        agentsPane.setPaneAgentsClock(undefined)
      }
    })

    it(`activity row survives ${name}`, async () => {
      activityPane.setActivityTimers({ setTimeout: () => 0 as never, clearTimeout: () => {} })
      activityPane.setActivityClock(() => 3_723_000)
      let facts = { ...initialConversationFacts(), active: true, turnStartedAt: 0, flowUp: 30_200, flowDownChars: 16_400 }
      let listener: ((value: typeof facts) => void) | undefined
      const section = { value: { transcriptView: 'standard' } as Record<string, unknown> }
      const agent = fakeAgent([])
      agent.status = 'running'
      const harness = await bootPanePlugin(activityPane, agent, {
        mayflyTick: { subscribe: () => () => {} },
        mayflyInteractionState: { settingsSource: () => section.value },
        mayflySessionFacts: {
          get current() { return facts },
          subscribe(next: (value: typeof facts) => void) { listener = next; next(facts); return () => {} },
          subscribeAgent(next: (value: unknown) => void) { next(agent); return () => {} },
        },
      })
      const locale = await harness.ctx.plugin({
        name: 'activity-width-locale',
        apply(ctx: Context) {
          const service = new MayflyLocaleService(ctx, { systemLocale: 'en' })
          ctx.effect(() => () => service.dispose())
        },
      })
      await Promise.resolve()
      try {
        const phases = [
          { phase: 'waiting', activity: { kind: 'tool', name: 'write', preparing: true } },
          { phase: 'thinking', activity: { kind: 'reasoning', detail: text } },
          { phase: 'composing', activity: { kind: 'text' } },
          { phase: 'tool', activity: { kind: 'tool', name: 'bash', detail: text } },
        ] as const
        for (const language of ['en', 'zh'] as const) {
          harness.ctx.mayflyLocale.setPreference(language)
          for (const view of ['compact', 'standard', 'detailed', 'verbose']) {
            section.value = { transcriptView: view }
            harness.ctx.emit('settings/document-updated', 'mayfly' as never, 1)
            for (const next of phases) {
              facts = { ...facts, ...next }
              listener?.(facts)
              for (const width of SCAN_WIDTHS) {
                expectLinesFit(`ActivityRow/${language}/${view}/${next.phase}/${name}`, harness.screen.paneLines(width), width)
              }
            }
          }
        }
      } finally {
        await locale.dispose()
        await harness.dispose()
        activityPane.setActivityTimers(undefined)
        activityPane.setActivityClock(undefined)
      }
    })

    it(`goal badge survives ${name}`, async () => {
      const harness = await bootPanePlugin(todoPane, fakeAgent([
        event('todo/write', { todos: [{ content: 'next', status: 'pending' }] }),
      ]))
      harness.facts.setGoal({
        goal: {
          id: 'width-goal',
          revision: 1,
          objective: text,
          phase: 'blocked',
          blockedReason: { code: 'width', message: text },
          maxGoalRounds: 8,
        },
        roundsStarted: 2,
        createdAt: 1,
        updatedAt: 2,
      } as GoalProjection)
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`GoalBadge/${name}`, harness.screen.paneLines(width), width)
      }
      await harness.dispose()
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
      for (const width of SCAN_WIDTHS) {
        if (bannerLayout(width) === null) continue
        expectLinesFit(`Banner/${name}`, composeBannerLines(deps, content, width), width)
      }
    })
  }

  it('StatusFooterComponent survives truncating long models at every width', () => {
    for (const { name, text } of ADVERSARIAL) {
      const components = fakeMayflyComponents()
      const status = new MayflyStatusService(new Context())
      const footer = new StatusFooterComponent(status, components, colors)
      status.register({ id: 'scan-title', priority: 90, band: 'right' }, { kind: 'text', content: text })
      status.register({ id: 'scan-left', priority: 10 }, { kind: 'text', content: text })
      status.register({ id: 'scan-context', priority: 4, band: 'right', overflow: 'hide' }, { kind: 'text', content: 'cache 34%  context: 18% (22.9k/128k)' })
      status.register({ id: 'scan-center', priority: 0, band: 'center' }, { kind: 'rich-text', spans: [{ text: 'MAIN', tone: 'accent' }, { text: ` · ${text}`, tone: 'muted' }] })
      status.register({ id: 'scan-goal', priority: 2, overflow: 'hide' }, {
        kind: 'text',
        content: goalStatusText({
          id: 'goal-width' as never,
          revision: 1,
          objective: text,
          phase: 'active',
          maxGoalRounds: 256,
          roundsStarted: 128,
          createdAt: 1,
          updatedAt: 2,
          activation: 'armed',
        }),
      })
      // The footer paints what was registered: a scan of empty rows would pass for any width.
      expect(footer.render(120).join('')).toContain('MAIN')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`FooterShell/${name}`, footer.render(width), width)
      }
    }
  })

})
