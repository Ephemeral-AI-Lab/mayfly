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
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ui } from '../../../ui/src/index.ts'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { helpNode, type HelpSection } from '../../src/interaction/help.ts'
import { jobDetailsNode, jobItems, jobOutputNode } from '../../src/interaction/jobs.ts'
import { documentPages } from '../../src/interaction/document-pages.ts'
import { SessionTranscriptPanel } from '../../src/interaction/session-transcript-panel.ts'
import { fakeMayflyContext } from './fakes.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { FakeProjectionService } from '../transcript/pane-fakes.ts'
import { userEvent } from '../transcript/helpers.ts'
import { renderRequest, requestFixture } from './request-fixture.ts'
import { settingsFixture, settingsField } from './settings-fixture.ts'

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
    intent: { kind: 'plan-review' as const, approve: text.slice(0, 40) },
    detail: text,
  }
}

describe('interaction width-scan', () => {
  for (const { name, text } of ADVERSARIAL) {
    for (const kind of ['form', 'multiselect'] as const) it(`shared ${kind} survives ${name}`, async () => {
      const bench = await requestFixture()
      try {
        const node = kind === 'form'
          ? ui.form({ id: 'form', fields: [{ kind: 'input', id: 'f1', label: text, value: 'visible-value', required: true }, { kind: 'input', id: 'f2', label: 'Short', value: '' }], submitActionId: 'save' })
          : ui.list({ id: 'choices', role: 'choose', mode: 'multiple', selectedIds: [], items: [{ id: 'hostile', label: text, detail: text }, { id: 'short', label: 'Short' }] })
        bench.ctx.mayflyOverlays.open({ id: 'width-case', capturing: true }, ui.surface({ title: text, subtitle: text, chrome: 'overlay', child: node }))
        const model = bench.ctx.mayflyUiInteraction.get('overlay', 'width-case')!
        const viewport = { columns: 80, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
            viewport.columns = width
            viewport.rows = height
            const rows = renderer.component.render(width)
            expectLinesFit(`shared-${kind}/${name}/${height}`, rows, width)
            expect(rows.length).toBeLessThanOrEqual(height)
          }
        } finally { renderer.runtime.dispose() }
      } finally { await bench.ctx.fiber.dispose() }
    })

    it(`Help document survives ${name}`, async () => {
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
      const bench = await requestFixture()
      try {
        bench.ctx.mayflyOverlays.open({ id: 'help-width', capturing: true }, helpNode(sections))
        const model = bench.ctx.mayflyUiInteraction.get('overlay', 'help-width')!
        const viewport = { columns: 80, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) {
            viewport.columns = width
            expectLinesFit(`HelpDocument/${name}`, renderer.component.render(width), width)
          }
        } finally { renderer.runtime.dispose() }
      } finally { await bench.ctx.fiber.dispose() }
    })

    it(`paged job output survives ${name}`, async () => {
      const bench = await requestFixture()
      const read = { snapshot: { id: 'large', label: 'Large output', status: 'completed' } as JobSnapshot, text: `${text}\n`.repeat(Math.ceil(13_000 / (text.length + 1))) }
      const pages = documentPages(read.text)
      try {
        for (const page of pages.keys()) {
          const handle = bench.ctx.mayflyOverlays.open({ id: 'job-output', capturing: true }, jobOutputNode(read, pages, page + 1, key => key))
          const model = bench.ctx.mayflyUiInteraction.get('overlay', 'job-output')!
          const viewport = { columns: 80, rows: 20 }
          const renderer = renderRequest(model, viewport)
          try {
            for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
              viewport.columns = width; viewport.rows = height
              const rows = renderer.component.render(width)
              expectLinesFit(`job-output/${name}/${page}/${height}`, rows, width)
              expect(rows.length).toBeLessThanOrEqual(height)
            }
          } finally { renderer.runtime.dispose(); handle.close() }
        }
      } finally { await bench.ctx.fiber.dispose() }
    })

    it(`native jobs documents survive ${name}`, async () => {
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
      const bench = await requestFixture()
      const nodes = [
        ui.list({ id: 'jobs', role: 'browse', selectedIds: [], items: jobItems([job], 61_000, key => key) }),
        jobDetailsNode(job, key => key),
        jobOutputNode({ snapshot: job, text }, [text], 1, key => key),
      ]
      try {
        for (const [index, node] of nodes.entries()) {
          const handle = bench.ctx.mayflyOverlays.open({ id: 'job-view', capturing: true }, node)
          const model = bench.ctx.mayflyUiInteraction.get('overlay', 'job-view')!
          const viewport = { columns: 80, rows: 20 }
          const renderer = renderRequest(model, viewport)
          try {
            for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
              viewport.columns = width; viewport.rows = height
              const rows = renderer.component.render(width)
              expectLinesFit(`native-jobs-${index}/${name}/${height}`, rows, width)
              expect(rows.length).toBeLessThanOrEqual(height)
            }
          } finally { renderer.runtime.dispose(); handle.close() }
        }
      } finally { await bench.ctx.fiber.dispose() }
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

    for (const kind of ['approval', 'plan', 'questionnaire'] as const) it(`shared request ${kind} survives ${name}`, async () => {
      const bench = await requestFixture()
      try {
        const pending = kind === 'approval' ? bench.approve({ toolName: text, reason: text }) : bench.ctx.userQuestions.ask({ questions: [kind === 'plan' ? planAsk(text) : ask(text)] })
        const cancelled = pending.catch(() => {})
        const model = bench.model(kind === 'approval' ? 'mayfly.approval.' : 'mayfly.questions.')
        const viewport = { columns: 80, rows: 24 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) for (const height of [24, 10, 5]) {
            viewport.columns = width
            viewport.rows = height
            const rows = renderer.component.render(width)
            expectLinesFit(`${kind}/${name}/${height}`, rows, width)
            expect(rows.length).toBeLessThanOrEqual(height)
          }
          if (kind !== 'questionnaire') {
            model.invoke(kind === 'approval' ? 'feedback' : 'revise', [{ controlId: kind === 'approval' ? 'approval' : 'review', itemId: 'decision' }])
            const feedbackRenderer = renderRequest(model, viewport)
            for (const width of SCAN_WIDTHS) expectLinesFit(`${kind}-feedback/${name}`, feedbackRenderer.component.render(width), width)
            feedbackRenderer.runtime.dispose()
            model.back()
          }
          model.requestClose()
          await cancelled
        } finally { renderer.runtime.dispose() }
      } finally { await bench.ctx.fiber.dispose() }
    })
    it(`shared settings survives ${name}`, async () => {
      const ctx = new Context()
      try {
        const bench = await settingsFixture(ctx, Schema.object({ value: Schema.string().default(text), choice: Schema.union([text, 'other']).default(text), enabled: Schema.boolean().default(true) }))
        const model = await bench.open()
        model.edit(settingsField('value'), `${text} modified`)
        const viewport = { columns: 80, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
            viewport.columns = width
            viewport.rows = height
            const rows = renderer.component.render(width)
            expectLinesFit(`shared-settings/${name}/${height}`, rows, width)
            expect(rows.length).toBeLessThanOrEqual(height)
          }
        } finally { renderer.runtime.dispose() }
      } finally { await ctx.fiber.dispose() }
    })
  }
})
