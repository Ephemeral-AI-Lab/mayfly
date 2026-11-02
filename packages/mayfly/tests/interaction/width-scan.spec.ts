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
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ui } from '../../../ui/src/index.ts'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FilesBrowser, type FilesBrowserFacts } from '../../src/interaction/files-browser-model.ts'
import { scheduleNode } from '../../src/interaction/schedule-command.ts'
import { accountPanelNode } from '../../src/interaction/provider-account.ts'
import { INTERACTION_LOCALE } from '../../src/interaction/locale.ts'
import { interpolateLocaleMessage, type MayflyLocaleId } from '../../src/frontend/locale.ts'
import { helpNode, type HelpSection } from '../../src/interaction/help.ts'
import { rewindNode } from '../../src/interaction/rewind.ts'
import { renamePanelModel } from '../../src/interaction/rename-model.ts'
import { agentsPanelModel } from '../../src/interaction/agents-model.ts'
import { createUpdateProgressState, updatePanelModel } from '../../src/interaction/update-model.ts'
import { tracePanelModel } from '../../src/interaction/trace-model.ts'
import { createRealSurface, probeComponents } from '../design/probe.ts'
import { jobDetailsNode, jobItems, jobOutputNode } from '../../src/interaction/jobs.ts'
import { sessionWorkspaceItem } from '../../src/interaction/session-workspaces-model.ts'
import { sessionDetailNode as sessionListDetailNode, sessionListItem } from '../../src/interaction/session-list-model.ts'
import { FakeKeymap } from './fakes.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'
import { MayflyStatusService } from '../../../ui/src/services.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import * as conversationViewStatus from '../../src/interaction/conversation-view-status.ts'
import { footerRows } from '../transcript/footer-fakes.ts'
import { renderRequest, requestFixture } from './request-fixture.ts'
import { settingsFixture, settingsField } from './settings-fixture.ts'
import { helpCatalogSections } from './help-catalog-fixture.ts'
import { plain } from '../helpers.ts'

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

    it(`Update progress, recovery and blocked panels survive ${name}`, async () => {
      const bench = await requestFixture()
      try {
        const state = createUpdateProgressState()
        state.steps.set('snapshot', 'ok')
        state.steps.set('rollback', 'fail')
        state.blockedMessage = text
        state.outcome = { kind: 'rollback-incomplete', fromVersion: text, toVersion: text, message: text, logPath: text }
        bench.ctx.mayflyOverlays.open({ id: 'update-width', capturing: true }, updatePanelModel(state, text, text))
        const model = bench.ctx.mayflyUiInteraction.get('overlay', 'update-width')!
        const viewport = { columns: 80, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
            viewport.columns = width
            viewport.rows = height
            expectLinesFit(`update/${name}/${height}`, renderer.component.render(width), width)
          }
        } finally { renderer.runtime.dispose() }
      } finally { await bench.ctx.fiber.dispose() }
    })

    it(`Rewind picker survives ${name}`, async () => {
      const bench = await requestFixture()
      try {
        bench.ctx.mayflyOverlays.open({ id: 'rewind-width', capturing: true }, rewindNode([{ turn: 1, boundarySeq: 1, prompt: text, response: text, discarded: 100 }]))
        const model = bench.ctx.mayflyUiInteraction.get('overlay', 'rewind-width')!
        const viewport = { columns: 80, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
            viewport.columns = width
            viewport.rows = height
            expectLinesFit(`rewind/${name}/${height}`, renderer.component.render(width), width)
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

    // Give each width its own test budget: the full document at all nine widths
    // otherwise shares one timeout under coverage and concurrent CI workers.
    for (const width of SCAN_WIDTHS) it(`job output survives ${name} at width ${width}`, async () => {
      const bench = await requestFixture()
      const job = { id: 'large', kind: 'bash', label: 'Large output', status: 'completed', startedAt: 1, output: { total: 0, earliest: 0 } } as JobView
      const text2 = `${text}\n`.repeat(Math.ceil(13_000 / (text.length + 1)))
      const read = { chunks: [{ at: 0, text: text2 }], next: text2.length, lossy: false }
      try {
        const handle = bench.ctx.mayflyOverlays.open({ id: 'job-output', capturing: true }, jobOutputNode(job, { dropped: read.lossy, chunks: read.chunks.map(chunk => ui.chunk(chunk.text)) }, key => key))
        const model = bench.ctx.mayflyUiInteraction.get('overlay', 'job-output')!
        const viewport = { columns: width, rows: 20 }
        const renderer = renderRequest(model, viewport)
        try {
          for (const height of [20, 7, 3]) {
            viewport.rows = height
            const rows = renderer.component.render(width)
            expectLinesFit(`job-output/${name}/${height}`, rows, width)
            expect(rows.length).toBeLessThanOrEqual(height)
          }
        } finally { renderer.runtime.dispose(); handle.close() }
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
        output: { total: 0, earliest: 0 },
      } as JobView
      const bench = await requestFixture()
      const nodes = [
        ui.list({ id: 'jobs', role: 'browse', selectedIds: [], items: jobItems([job], 61_000, key => key) }),
        jobDetailsNode(job, key => key),
        jobOutputNode(job, { dropped: false, chunks: [ui.chunk(text)] }, key => key),
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
    it(`sessions rows and detail survive ${name}`, async () => {
      const bench = await requestFixture()
      const facts = {
        id: `session-${name}`,
        title: text,
        cwd: `/repo/${name}`,
        createdAt: 1_000,
        lastActiveAt: 61_000,
        running: true,
        archived: true,
        current: true,
        reminders: true,
        parentId: 'parent-id',
        preset: 'standard',
        tokens: { input: 1_500, cacheRead: 100, cacheWrite: 50, output: 500 },
        stats: { turns: 2, steps: 4, llmMs: 61_000, toolMs: 2_000, ttftMs: 100, ttftSteps: 1, decodeMs: 900, decodeTokens: 50 },
        model: { provider: 'deepseek', model: text },
      }
      const nodes = [
        ui.stack.column([
          ui.loader({ message: 'Loading workspaces…' }),
          ui.list({ id: 'workspaces', role: 'browse', selectedIds: [], filterable: true, items: [sessionWorkspaceItem({ id: 'workspace', cwd: facts.cwd, count: 1284, createdAt: 1000 }, facts.cwd, '/home/dev', key => key)] }),
        ]),
        ui.stack.column([
          ui.loader({ message: 'Loading session names… 12/1284' }),
          ui.list({ id: 'sessions', role: 'browse', selectedIds: [], items: [sessionListItem(facts, 1_800_000_000_000, '/home/dev', key => key, false)] }),
        ]),
        ui.list({ id: 'sessions', role: 'browse', selectedIds: [], items: [sessionListItem(facts, 1_800_000_000_000, '/home/dev', key => key)] }),
        sessionListDetailNode(facts, 1_800_000_000_000, key => key),
      ]
      try {
        for (const [index, node] of nodes.entries()) {
          const handle = bench.ctx.mayflyOverlays.open({ id: 'session-view', capturing: true }, ui.surface({ title: 'Sessions', chrome: 'overlay', child: node }))
          const model = bench.ctx.mayflyUiInteraction.get('overlay', 'session-view')!
          const viewport = { columns: 80, rows: 20 }
          const renderer = renderRequest(model, viewport)
          try {
            for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
              viewport.columns = width; viewport.rows = height
              const rows = renderer.component.render(width)
              expectLinesFit(`sessions-${index}/${name}/${height}`, rows, width)
              expect(rows.length).toBeLessThanOrEqual(height)
            }
          } finally { renderer.runtime.dispose(); handle.close() }
        }
      } finally { await bench.ctx.fiber.dispose() }
    })
    it(`conversation view status survives ${name}`, async () => {
      const ctx = new Context()
      const agents = new Map([['primary', { id: SessionId('primary') }], ['btw', { id: SessionId('btw') }]])
      ctx.reflect.provide('agents', { get: (id: unknown) => agents.get(String(id)) })
      ctx.reflect.provide('mayflyKeymap', new FakeKeymap())
      const conversations = new MayflyConversationsService(ctx)
      conversations.selectPrimary(agents.get('primary') as never)
      conversations.open({ kind: 'subagent', sessionId: 'child', parentSessionId: 'primary', label: text, mode: 'one-shot' })
      conversations.open({ kind: 'btw', sessionId: 'btw', parentSessionId: 'primary', label: text })
      conversations.open({ kind: 'subagent', sessionId: 'cold', parentSessionId: 'primary', label: text, mode: 'continuable' })
      const status = new MayflyStatusService(ctx)
      await ctx.plugin(conversationViewStatus)
      const footer = (width: number): string[] => footerRows(status.list(), width, fakeMayflyComponents(), COLORS)
      for (const width of SCAN_WIDTHS) expectLinesFit(`ConversationViewStatus/${name}`, footer(width), width)
      conversations.back()
      for (const width of SCAN_WIDTHS) expectLinesFit(`ConversationViewStatus/back/${name}`, footer(width), width)
      await ctx.fiber.dispose()
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
            /* The note field carries the typed text in the card's own rows; a long note wraps inside every width. */
            model.edit({ pagePath: [], formId: 'decision.note', fieldId: 'note' }, text)
            const noteRenderer = renderRequest(model, viewport)
            for (const width of SCAN_WIDTHS) expectLinesFit(`${kind}-note/${name}`, noteRenderer.component.render(width), width)
            noteRenderer.runtime.dispose()
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

for (const { name, text } of ADVERSARIAL) it(`native feature catalogs fit ${name}`, async () => {
  const bench = await requestFixture()
  try {
    const reminders = [{ id: 'schedule', title: text, prompt: text, kind: 'every', everySeconds: 300, scheduledAt: '2099-01-01T00:00:00Z' }] as never
    const links = { usageUrl: `https://example/${text}`, topUpUrl: `https://example/${text}` }
    const nodes = [
      ...(['en', 'zh'] as const).flatMap((locale: MayflyLocaleId) => {
        const t = (key: string, values?: Record<string, string | number>) => interpolateLocaleMessage(INTERACTION_LOCALE[locale][key] ?? INTERACTION_LOCALE.en[key] ?? key, values)
        return [
          accountPanelNode({ status: 'signed-out', links, attempt: null }, t, true),
          accountPanelNode({ status: 'credential-stored', links, attempt: null }, t, true),
          accountPanelNode({ status: 'signed-out', links, attempt: { id: 'attempt' as never, phase: 'waiting-browser', authorizeUrl: text, expiresAt: Date.now() + 600_000 } }, t, true, 41321),
          accountPanelNode({ status: 'signed-out', links, attempt: { id: 'attempt' as never, phase: 'waiting-browser', authorizeUrl: text, expiresAt: 1 } }, t, true),
          accountPanelNode({ status: 'signed-out', links, attempt: null }, t, false),
          scheduleNode(reminders, Date.now(), t, locale),
          scheduleNode([], Date.now(), t, locale),
          scheduleNode(undefined, Date.now(), t, locale),
        ]
      }),
    ]
    for (const node of nodes) {
      const handle = bench.ctx.mayflyOverlays.open({ id: 'native-width', capturing: true }, node)
      const model = bench.ctx.mayflyUiInteraction.get('overlay', 'native-width')!
      for (const width of SCAN_WIDTHS) {
        const renderer = renderRequest(model, { columns: width, rows: 12 })
        expectLinesFit(`native/${name}`, renderer.component.render(width), width)
        renderer.runtime.dispose()
      }
      handle.close()
    }
  } finally { await bench.ctx.fiber.dispose() }
})

for (const { name, text } of ADVERSARIAL) it(`Files browser list, detail, preview and diff survive ${name}`, async () => {
  const bench = await requestFixture()
  const file = { id: 'delivered', path: text, description: text }
  const latest = { seq: 3, summary: { turn: 2, cwd: '/host/work', files: [{ path: text, display: text, added: 10, deleted: 1 }], total: 1, added: 10, deleted: 1 } }
  const base: FilesBrowserFacts = { files: [file], latest, focusedId: file.id, detailMode: false, canOpen: true }
  const cases: readonly FilesBrowserFacts[] = [
    base,
    { ...base, detailMode: true, detail: { kind: 'delivered', path: text, displayPath: text, fileType: 'file', previewable: true, size: 1 } },
    { ...base, detailMode: true, detail: { kind: 'delivered', path: text, fileType: 'file', previewable: true, preview: text } },
    { ...base, focusedId: 'changes:3:0', detailMode: true, detail: { kind: 'changed', diff: { kind: 'text', path: text, display: text, before: true, after: true, coarse: true, hunks: [{ oldStart: 100, oldLines: 1, newStart: 100, newLines: 1, lines: [`-${text}`, `+${text}`] }] } } },
  ]
  try {
    for (const [index, facts] of cases.entries()) {
      const handle = bench.ctx.mayflyOverlays.open({ id: 'files-width', capturing: true }, FilesBrowser(facts, key => key))
      const model = bench.ctx.mayflyUiInteraction.get('overlay', 'files-width')!
      const viewport = { columns: 80, rows: 20 }
      const renderer = renderRequest(model, viewport)
      try {
        for (const width of SCAN_WIDTHS) for (const height of [20, 7, 3]) {
          viewport.columns = width
          viewport.rows = height
          const rows = renderer.component.render(width)
          expectLinesFit(`files-${index}/${name}/${height}`, rows, width)
          expect(rows.length).toBeLessThanOrEqual(height)
        }
      } finally { renderer.runtime.dispose(); handle.close() }
    }
  } finally { await bench.ctx.fiber.dispose() }
})
