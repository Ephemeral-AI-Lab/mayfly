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
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import * as activityPane from '../../src/transcript/pane-activity.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import * as todoPane from '../../src/transcript/pane-todo.ts'
import { workflowNode, type WorkflowRunState } from '../../src/transcript/pane-workflow.ts'
import * as goalStatus from '../../src/transcript/status-goal.ts'
import * as agentsStatus from '../../src/transcript/status-agents.ts'
import * as jobsStatus from '../../src/transcript/status-jobs.ts'
import { footerRows } from './footer-fakes.ts'
import { composeBannerLines, shortenHome } from '../../src/transcript/banner.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { bootPanePlugin } from './pane-fakes.ts'
import { COLORS, fakeAgent } from './status-fakes.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
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

    it(`agents item survives ${name}`, () => {
      const t = transcriptTranslatorFake
      const rows = agentsStatus.agentRows([
        { seq: 1, turn: 1, step: 1, callId: 'fg', name: 'subagent', arguments: JSON.stringify({ name: text, description: text, prompt: text }), startedAt: 1_000 },
        { seq: 2, turn: 1, step: 1, callId: 'bg', name: 'subagent', arguments: JSON.stringify({ name: text, description: text }), startedAt: 1_000, result: { text: 'started subagent c1', isError: false, endedAt: 2_000 } },
        { seq: 3, turn: 1, step: 1, callId: 'bad', name: 'subagent', arguments: JSON.stringify({ name: text }), startedAt: 1_000, result: { text, isError: true, endedAt: 9_000 } },
      ], [{ id: 'c1', phase: 'running', tokens: 99_999, inputTokens: 90_000, outputTokens: 9_999, toolCount: 12_345, liveChars: 40_000, activity: text }], { turn: 1, active: true })
      const state = { rows, now: 3_000 }
      const panel = agentsStatus.agentsPanel(state, t, () => ({ 'agents-stop': text, 'agents-background': text }))
      if (panel === null) throw new Error('agents width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`AgentsPanel/${name}`, renderNode(panel, width), width)
        expectLinesFit(`AgentsItem/${name}`, footerRows([{ id: 'views/agents', definition: { id: 'views/agents', priority: 11 }, node: agentsStatus.agentsSummary(state, t)!.node, revision: 1 }], width, fakeMayflyComponents(), colors), width)
      }
    })

    it(`jobs item survives ${name}`, () => {
      const t = transcriptTranslatorFake
      const jobs = [
        { id: 'a', kind: 'bash', label: text, status: 'running', startedAt: 1_000, progress: text, output: { total: 0, earliest: 0 } },
        { id: 'b', kind: 'bash', label: text, status: 'failed', startedAt: 1_000, finishedAt: 5_000, detail: text, output: { total: 0, earliest: 0 } },
      ] as never[]
      const state = { jobs, now: 3_000, history: true }
      const panel = jobsStatus.jobsPanel(state, t, () => ({ 'jobs-stop': text }))
      if (panel === null) throw new Error('jobs width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`JobsPanel/${name}`, renderNode(panel, width), width)
        expectLinesFit(`JobsItem/${name}`, footerRows([{ id: 'views/jobs', definition: { id: 'views/jobs', priority: 12 }, node: jobsStatus.jobsSummary(state, t)!.node, revision: 1 }], width, fakeMayflyComponents(), colors), width)
      }
    })

    it(`todo item survives ${name}`, () => {
      const t = transcriptTranslatorFake
      const state = { todos: [{ content: text, status: 'in_progress' }, { content: text, status: 'pending' }, ...Array.from({ length: 9 }, () => ({ content: text, status: 'completed' }))] as never[], interrupted: true, history: true, elapsedMs: 4_000_000 }
      const panel = todoPane.todoPanel(state, t)
      if (panel === null) throw new Error('todo width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`TodoPanel/${name}`, renderNode(panel, width), width)
        expectLinesFit(`TodoItem/${name}`, footerRows([{ id: 'views/todo', definition: { id: 'views/todo', priority: 14 }, node: todoPane.todoSummary(state, t)!.node, revision: 1 }], width, fakeMayflyComponents(), colors), width)
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
          currentGoal: null,
          subscribeGoal() { return () => {} },
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

    it(`goal item survives ${name}`, () => {
      const t = transcriptTranslatorFake
      const view = {
        id: 'width-goal', revision: 1, objective: text, phase: 'blocked', blockedReason: { code: 'width', message: text },
        maxGoalRounds: 8, roundsStarted: 2, createdAt: 1, updatedAt: 2, activation: 'armed',
      } as never
      const state = { goal: view }
      const panel = goalStatus.goalPanel(state, t)
      if (panel === null) throw new Error('goal width fixture did not render')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`GoalPanel/${name}`, renderNode(panel, width), width)
        expectLinesFit(`GoalItem/${name}`, footerRows([{ id: 'views/goal', definition: { id: 'views/goal', priority: 13 }, node: goalStatus.goalSummary(state, t)!.node, revision: 1 }], width, fakeMayflyComponents(), colors), width)
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

  it('the status row survives long models, directories, and chips at every width, and shows what was registered', () => {
    for (const { name, text } of ADVERSARIAL) {
      const components = fakeMayflyComponents()
      const status = new MayflyStatusService(new Context())
      status.register({ id: 'scan-title', priority: 90, band: 'right' }, { kind: 'text', content: text })
      status.register({ id: 'scan-left', priority: 10 }, { kind: 'text', content: text })
      status.register({ id: 'scan-context', priority: 4, band: 'right', overflow: 'hide' }, { kind: 'text', content: 'cache ▰▰▱▱▱ 34%  ctx ▰▰▱▱▱▱▱▱▱▱ 18%' })
      status.register({ id: 'scan-center', priority: 0, band: 'center', overflow: 'truncate' }, { kind: 'rich-text', spans: [{ text: 'MAIN', tone: 'accent' }, { text: ` · ${text}`, tone: 'muted' }] })
      status.register({ id: 'scan-goal', priority: 2, overflow: 'hide' }, goalStatus.goalSummary({
        goal: { id: 'goal-width' as never, revision: 1, objective: text, phase: 'active', maxGoalRounds: 256, roundsStarted: 128, createdAt: 1, updatedAt: 2, activation: 'armed' } as never,
      }, transcriptTranslatorFake)!.node)
      // The footer paints what was registered: a scan of empty rows would pass for any width.
      expect(footerRows(status.list(), 120, components, colors).join('')).toContain('MAIN')
      for (const width of SCAN_WIDTHS) expectLinesFit(`StatusRow/${name}`, footerRows(status.list(), width, components, colors), width)
      // The entered item's heavy second line also fits.
      for (const width of SCAN_WIDTHS) expectLinesFit(`StatusRow/entered/${name}`, footerRows(status.list(), width, components, colors, { active: 'scan-goal' }), width)
    }
  })

})
