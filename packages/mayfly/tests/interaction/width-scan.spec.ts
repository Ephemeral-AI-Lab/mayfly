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

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as approvalPlugin from '../../src/interaction/approval-plugin.ts'
import { CanonicalFormController, type FormField } from '../../src/interaction/form-panel.ts'
import { HelpPanel, type HelpSection } from '../../src/interaction/help.ts'
import { InfoPanel, type InfoSection } from '../../src/interaction/info-panel.ts'
import { CanonicalDocumentController } from '../../src/interaction/frontend-panel.ts'
import { jobOutputPanelModel, jobsPanelModel } from '../../src/interaction/jobs.ts'
import { PlanReviewPanel, planReviewChoices } from '../../src/interaction/plan-review-panel.ts'
import { Questionnaire } from '../../src/interaction/questionnaire.ts'
import { CanonicalSelectController } from '../../src/interaction/select-list.ts'
import { CanonicalMultiSelectController } from '../../src/interaction/select.ts'
import { CanonicalSettingsController, SettingsNoticeController } from '../../src/interaction/settings-command.ts'
import { UpdateNoticeComponent } from '../../src/interaction/update-notice.ts'
import { SessionTranscriptPanel } from '../../src/interaction/session-transcript-panel.ts'
import { fakeMayflyContext, FakeMayflyComponents, FakeKeymap } from './fakes.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { FakeProjectionService } from '../transcript/pane-fakes.ts'
import { userEvent } from '../transcript/helpers.ts'

/**
 * Identity theme: the width scan measures rows through the same visible
 * width the renderer uses, so marker paints (whose literals add columns the
 * production SGR paints do not) would read as false overflows.
 */
const id = (text: string): string => text
const IDENTITY_THEME = {
  colors: {
    text: id, textStrong: id, muted: id, textMuted: id, accent: id, primary: id, border: id,
    borderFocus: id, success: id, error: id, warning: id, selectedBg: id, roleUser: id,
    shellMode: id,
    mdHeading: id, mdLink: id, mdLinkUrl: id, mdCode: id, mdCodeBlock: id,
    mdCodeBlockBorder: id, mdQuote: id, mdQuoteBorder: id, mdHr: id, mdListBullet: id,
    diffAdded: id, diffRemoved: id, diffAddedStrong: id, diffRemovedStrong: id,
    diffGutter: id, diffMeta: id,
  },
}

/** One questionnaire ask whose option label and description are the fixture. */
function ask(text: string) {
  return {
    id: 'q1',
    question: text,
    options: [
      { label: text, description: text },
      { label: 'Beta' },
    ],
  }
}

/** A plan-review ask whose question and options carry the fixture. */
function planAsk(text: string) {
  return {
    id: 'pr',
    question: text,
    options: [
      { label: text.slice(0, 40), description: text },
      { label: 'Keep planning', description: 'Stay in plan mode; refine first.' },
    ],
    intent: { kind: 'plan-review', approve: text.slice(0, 40) },
  }
}

describe('interaction width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    it(`UpdateNoticeComponent survives ${name}`, () => {
      const { components } = fakeMayflyContext()
      const notice = new UpdateNoticeComponent(
        (line, width) => components.truncateToWidth(line, width),
        { current: '0.1.0-rc.2', target: text.slice(0, 20), command: `dsh plugin --profile mayfly add @ephemeral-ai/mayfly@${text.slice(0, 12)}` },
      )
      for (const width of SCAN_WIDTHS) expectLinesFit(`UpdateNotice/${name}`, notice.render(width), width)
    })
    it(`canonical form survives ${name}`, () => {
      const { keymap, components } = fakeMayflyContext()
      const fields: FormField[] = [
        { id: 'f1', label: text, required: true },
        { id: 'f2', label: 'Short' },
      ]
      const panel = new CanonicalFormController({
        keymap, theme: IDENTITY_THEME as never, components,
        title: text,
        subtitle: text,
        fields,
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-form/${name}`, panel.render(width), width)
      }
    })

    it(`canonical single-select survives ${name}`, () => {
      const panel = new CanonicalSelectController({
        keymap: new FakeKeymap(),
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        rows: [
          { value: 'hostile', label: text, description: text, badge: text },
          { value: 'short', label: 'Short' },
        ],
        title: text,
        titleHint: text,
        footer: text,
        filter: true,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-single-select/${name}`, panel.render(width), width)
      }
    })

    it(`canonical multi-select survives ${name}`, () => {
      const panel = new CanonicalMultiSelectController({
        keymap: new FakeKeymap(),
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        items: [
          { value: 'hostile', label: text, description: text },
          { value: 'short', label: 'Short' },
        ],
        title: text,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-multi-select/${name}`, panel.render(width), width)
      }
    })

    it(`HelpOverlay survives ${name}`, () => {
      const sections: HelpSection[] = [
        {
          heading: 'Commands',
          labelTone: 'accent',
          rows: [
            { label: text, description: text },
            { label: '/short', description: 'fits anywhere' },
          ],
        },
      ]
      const overlay = new HelpPanel({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        keymap: new FakeKeymap(),
        sections,
        onClose: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`HelpOverlay/${name}`, overlay.render(width), width)
      }
    })

    it(`InfoPanel survives ${name}`, () => {
      const sections: InfoSection[] = [
        {
          heading: 'Session',
          rows: [
            { label: text, segments: [{ text }] },
            { label: 'id', segments: [{ text }, { text, style: 'muted' as const }] },
          ],
        },
      ]
      const panel = new InfoPanel({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        keymap: new FakeKeymap(),
        title: text,
        sections,
        onClose: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`InfoPanel/${name}`, panel.render(width), width)
      }
    })

    it(`canonical document survives ${name}`, () => {
      const panel = new CanonicalDocumentController({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        keymap: new FakeKeymap(),
        model: () => ({
          kind: 'panel', mode: 'select', title: text,
          header: { kind: 'text', text },
          view: { kind: 'list', filterable: true, grouped: true, items: [
            { id: 'a', label: text, detail: text, group: text, variants: [{ id: 'v', label: text, action: { kind: 'pick' } }] },
            { id: 'b', label: text, group: 'other', action: { kind: 'pick' } },
          ] },
        }),
        onAction: vi.fn(),
        onClose: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-document/${name}`, panel.render(width), width)
      }
    })

    it(`canonical loading document survives ${name}`, () => {
      const panel = new CanonicalDocumentController({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        keymap: new FakeKeymap(),
        model: () => ({
          mode: 'loading',
          title: text,
          view: { kind: 'text', content: text },
          dismissible: false,
        }),
        onAction: vi.fn(),
        onClose: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-loading-document/${name}`, panel.render(width), width)
      }
    })

    it(`native jobs documents survive ${name}`, () => {
      const job = {
        id: text,
        kind: 'bash',
        label: text,
        status: 'failed',
        startedAt: 1,
        finishedAt: 2,
        detail: text,
        reported: false,
      } as JobSnapshot
      const panels = [
        new CanonicalDocumentController({
          theme: IDENTITY_THEME as never,
          components: new FakeMayflyComponents(),
          keymap: new FakeKeymap(),
          model: () => jobsPanelModel([job], 61_000, key => key),
          onAction: vi.fn(),
          onClose: vi.fn(),
        }),
        new CanonicalDocumentController({
          theme: IDENTITY_THEME as never,
          components: new FakeMayflyComponents(),
          keymap: new FakeKeymap(),
          model: () => jobOutputPanelModel(job, text, key => key),
          onAction: vi.fn(),
          onClose: vi.fn(),
        }),
      ]
      for (const width of SCAN_WIDTHS) {
        panels.forEach((panel, index) => {
          expectLinesFit(`native-jobs-${String(index)}/${name}`, panel.render(width), width)
        })
      }
    })
    it(`SessionTranscriptPanel survives ${name}`, () => {
      const { ctx } = fakeMayflyContext({ agents: false })
      const child = {
        id: SessionId(`readonly-${name}`),
        header: { cwd: '/repo', origin: 'subagent', parentSession: SessionId('parent') },
        events: [userEvent(text)],
      } as unknown as Session
      ctx.set('sessionProjections', new FakeProjectionService() as never)
      ctx.provide('sessions', { list: () => [child] } as never)
      ctx.provide('agents', { get: () => undefined } as never)
      const panel = new SessionTranscriptPanel(ctx, {
        kind: 'subagent', sessionId: String(child.id), parentSessionId: 'parent', label: text, mode: 'one-shot',
      }, vi.fn())
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`SessionTranscriptPanel/${name}`, panel.render(width), width)
      }
      panel.dispose()
    })

    it(`approval plugin prompt survives ${name}`, async () => {
      const { ctx, screen } = fakeMayflyContext()
      const agent = {
        id: `approval-width-${name}`,
        status: 'idle',
        inbox: { nextTurn: [], nextStep: [], remove: () => false },
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
      } as unknown as Agent
      ctx.provide('testSession', { current: agent, modelRef: undefined })
      await ctx.plugin(approvalPlugin)
      const request: ApprovalRequest = { agent, toolName: text, reason: text }
      const pending = ctx.waterfall(
        'approval/request',
        request,
        () => Promise.resolve<ApprovalOutcome>('unavailable'),
      )
      const component = screen.overlays.at(-1)?.component
      if (component === undefined) throw new Error('approval prompt did not mount')
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`approval-plugin/${name}`, component.render(width), width)
      }
      component.handleInput?.('\x1b')
      await pending
      await ctx.fiber.dispose()
    })

    it(`PlanReviewPanel survives ${name}`, () => {
      const question = planAsk(text) as Parameters<typeof planReviewChoices>[0]
      const choices = planReviewChoices(question)
      expect(choices).toBeDefined()
      const panel = new PlanReviewPanel({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        question,
        choices: choices!,
        viewportRows: () => 24,
        onComplete: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`PlanReviewPanel/${name}`, panel.render(width), width)
      }
    })

    it(`Questionnaire survives ${name}`, () => {
      const questionnaire = new Questionnaire({
        theme: IDENTITY_THEME as never,
        components: new FakeMayflyComponents(),
        questions: [ask(text)] as never,
        onComplete: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`Questionnaire/${name}`, questionnaire.render(width), width)
      }
      questionnaire.handleInput('\x1b')
    })
    it(`canonical settings survives ${name}`, () => {
      const components = new FakeMayflyComponents()
      const items = [
        { id: 'a', label: text, description: text, currentValue: text, values: [text, 'other'] },
        { id: 'b', label: 'Short', currentValue: '1', values: ['1', '2'] },
      ]
      const panel = new CanonicalSettingsController({
        theme: IDENTITY_THEME as never,
        components,
        keymap: new FakeKeymap(),
        title: `settings › ${text}`,
        footer: ['↑↓ select', text, 'esc back'],
        items: [
          ...items,
        ],
        notice: { current: { text, error: true } },
        onChange: vi.fn(),
        onCancel: vi.fn(),
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`canonical-settings/${name}`, panel.render(width), width)
      }
      panel.handleInput('\x1b')
    })

    it(`settings notice survives ${name}`, () => {
      const components = new FakeMayflyComponents()
      const tail = new SettingsNoticeController({
        // The inner panel budgets its own rows (the canonical selector
        // contract); the tail's own addition is the truncated notice row.
        inner: {
          focused: false,
          currentNode: () => ({ kind: 'text', content: text }),
          handleInput: () => {},
          invalidate: () => {},
        },
        components,
        theme: IDENTITY_THEME as never,
        notice: { current: { text, error: false } },
      })
      for (const width of SCAN_WIDTHS) {
        expectLinesFit(`settings-notice/${name}`, tail.render(width), width)
      }
      tail.handleInput('\x1b')
      tail.invalidate()
    })
  }
})
