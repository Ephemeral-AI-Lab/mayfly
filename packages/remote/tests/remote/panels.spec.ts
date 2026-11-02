/** Headless command overlay ownership through the real shared provider. @module tests/remote/panels */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { compileMayflyUiNode, MayflyComponentsService, visibleWidth, type MayflyComponentsDeps, type MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { RemotePlainPanels } from '../../src/remote/interactions/plain-panels.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'
import type { RemoteSessionUsageFacts } from '../../src/remote/session-information.ts'
import { changelogNode, CHANGELOG_ENTRIES, interactionTranslator } from '@ephemeral-ai/mayfly/command-panels'
import { panel, ui } from '@ephemeral-ai/mayfly-ui'

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  ctx.provide('mayflyKeymap', { list: () => [
    { id: 'test', keys: 'ctrl+k', description: 'Test key' },
    { id: 'labelled', keys: ['f1', 'f2'], label: 'Fallback key label' },
    { id: 'unlabelled-key-id', keys: 'f3' },
  ] } as never)
  const panels = new RemotePlainPanels(ctx)
  const text = () => JSON.stringify(ctx.mayflyOverlays.list()[0]?.node)
  return { ctx, panels, text }
}

const facts: RemotePresentationFacts = {
  ref: { host: HostKey('local'), sessionId: SessionId('session-1') }, cwd: '/work/mayfly', title: 'Remote architecture',
  model: 'deepseek-chat', provider: 'deepseek', mode: undefined, status: undefined, queue: [],
  contextTokens: 1024, contextWindow: 2048, active: true, phase: 'thinking',
}

describe('shared wire command panels', () => {
  it('shows reference Help with aliases and key sections, replaces panels and unloads registrations', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showHelp([{ name: 'quit', description: 'Exit Mayfly', aliases: ['q', 'exit'] }])
      expect(text()).toContain('/quit (/q, /exit)')
      expect(text()).toContain('Panels and pickers')
      expect(text()).toContain('Test key')
      expect(text()).toContain('Fallback key label')
      expect(text()).toContain('unlabelled-key-id')
      expect(ctx.mayflyOverlays.list()[0]!.definition.presentation).toBe('editor')
      panels.showVersion()
      expect(ctx.mayflyOverlays.list()).toHaveLength(1)
      expect(text()).toContain('Harness')
      panels.dispose()
      panels.dispose()
      expect(ctx.mayflyOverlays.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('publishes actual status facts and handles absent usage and selection', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showStatus(facts)
      expect(text()).toContain('50% (1k/2k)')
      expect(text()).toContain('State: thinking')
      panels.showStatus({ ...facts, contextWindow: undefined, title: undefined })
      expect(text()).toContain('Context: 1k tokens')
      panels.showStatus({ ...facts, contextTokens: 0, ref: undefined, cwd: '', model: undefined, provider: undefined, active: false })
      expect(text()).toContain('Context: no usage yet')
      expect(text()).toContain('Host: none')
      expect(text()).toContain('State: idle')
    } finally { await ctx.fiber.dispose() }
  })

  it('revokes actions on replaced panels and closes the current overlay through its endpoint', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showHelp([])
      const previous = ctx.mayflyOverlays.list()[0]!
      panels.showVersion()
      const current = ctx.mayflyOverlays.list()[0]!
      const event = { kind: 'dismiss' as const, pagePath: [] }
      const eventContext = { surfaceId: previous.id, source: [], signal: new AbortController().signal, revision: previous.revision, operationId: 'dismiss', report: vi.fn() }
      await previous.events.prepare(event, eventContext)
      expect(text()).toContain('Harness')
      // The endpoint rejects old deliveries; an action already queued at retirement
      // must also be fenced by the feature's own generation.
      expect(await previous.definition.onEvent!.action!(event, eventContext)).toEqual({ kind: 'cancelled' })
      const irrelevant = { kind: 'activate' as const, pagePath: [], controlId: 'other', actionId: 'other' }
      expect(await current.definition.onEvent!.action!(irrelevant, { ...eventContext, surfaceId: current.id, revision: current.revision })).toEqual({ kind: 'completed' })
      expect(text()).toContain('Harness')
      await current.events.prepare(event, { ...eventContext, surfaceId: current.id, revision: current.revision })
      expect(ctx.mayflyOverlays.list()).toEqual([])
      const registry = ctx.mayflyOverlays
      await ctx.fiber.dispose()
      expect(registry.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('fences an already queued locale callback after the document is replaced', async () => {
    const { ctx, panels, text } = await fixture()
    const subscribe = vi.spyOn(ctx.mayflyLocale, 'subscribe')
    try {
      panels.showHelp([])
      const queued = subscribe.mock.calls.map(([listener]) => listener)
      expect(queued.length).toBeGreaterThan(0)
      panels.showVersion('new native version')
      const revision = ctx.mayflyOverlays.list()[0]!.revision
      for (const callback of queued) callback(ctx.mayflyLocale.snapshot)
      expect(ctx.mayflyOverlays.list()[0]!.revision).toBe(revision)
      expect(text()).toContain('new native version')
      expect(text()).not.toContain('Panels and pickers')
    } finally { subscribe.mockRestore(); await ctx.fiber.dispose() }
  })

  it('shows an explicitly unavailable initial Context without inventing native usage', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showContext({ read: () => undefined, subscribe: () => () => {} })
      expect(text()).toContain('Session information unavailable')
      expect(text()).not.toContain('Context window')
    } finally { await ctx.fiber.dispose() }
  })

  it('refreshes an open document when locale changes', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showHelp([])
      ctx.mayflyLocale.setPreference('zh')
      await vi.waitFor(() => { expect(text()).toContain('帮助') })
      panels.dispose()
      ctx.mayflyLocale.setPreference('en')
      expect(ctx.mayflyOverlays.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('uses actual aliases, first ownership, translated descriptions and a final Remote section', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showHelp([
        { name: 'theme', description: 'Switch the color theme', aliases: ['color'] },
        { name: 'theme', description: 'duplicate Host description' },
        { name: 'quit', description: 'Exit Mayfly', aliases: [] },
        { name: 'attach', description: 'Attach a Host URL', group: 'remote' },
      ])
      expect(text()).toContain('/theme (/color)')
      expect(text()).not.toContain('/quit ()')
      expect(text()).not.toContain('duplicate Host description')
      expect(text().indexOf('Panels and pickers')).toBeLessThan(text().indexOf('Remote'))
      expect(text().indexOf('Remote')).toBeLessThan(text().indexOf('/attach'))
      ctx.mayflyLocale.setPreference('zh')
      await vi.waitFor(() => { expect(text()).toContain('退出 Mayfly') })
      panels.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('uses shared version fields and marks an unadvertised Host version', async () => {
    const { ctx, panels, text } = await fixture()
    try {
      panels.showVersion('0.2.2-alpha.2')
      expect(text()).toContain('Mayfly')
      expect(text()).toContain('Harness')
      expect(text()).toContain('0.2.2-alpha.2')
      panels.showVersion()
      expect(text()).toContain('not advertised by the Host')
    } finally { await ctx.fiber.dispose() }
  })

  it('shows the reference changelog with scrolling, live locale and app-owned dismissal', async () => {
    const { ctx, panels, text } = await fixture()
    const t = interactionTranslator(ctx)
    const expected = () => panel({ title: t('Changelog'), escapeLabel: 'back',
      body: ui.stack.column([ui.child(ui.scroll(changelogNode(CHANGELOG_ENTRIES, t), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })]),
    })
    try {
      panels.showChangelog()
      const entry = ctx.mayflyOverlays.list()[0]!
      expect(entry.definition).toMatchObject({ presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'changelog' } })
      expect(entry.node).toEqual(expected())
      expect(text()).toContain('0.1.4-rc.2')
      ctx.mayflyLocale.setPreference('zh')
      await vi.waitFor(() => { expect(text()).toContain('变更记录') })
      expect(ctx.mayflyOverlays.list()[0]!.node).toEqual(expected())
      panels.dispose()
      ctx.mayflyLocale.setPreference('en')
      expect(ctx.mayflyOverlays.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps shared context usage current and closes it when its native selection retires', async () => {
    const { ctx, panels, text } = await fixture()
    let current: RemoteSessionUsageFacts | undefined = {
      model: { model: 'native-model', provider: 'native-provider' },
      usage: { buckets: { input: 100, cacheRead: 100, cacheWrite: 0, output: 50 }, context: { used: 1024, window: 2048 } },
      composition: { system: 100, tools: 200, messages: 724 },
    }
    const listeners = new Set<() => void>()
    try {
      panels.showContext({ read: () => current, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
      expect(text()).toContain('Context window')
      expect(text()).toContain('1k / 2k (50%)')
      expect(text()).toContain('Session usage')
      expect(text()).toContain('Cache hit rate')
      expect(text()).toContain('Estimated usage by category')
      const old = [...listeners][0]!
      current = { usage: { buckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, context: {} } }
      old()
      expect(text()).toContain('no provider usage recorded yet')
      const overlay = ctx.mayflyOverlays.list()[0]!
      await overlay.events.prepare({ kind: 'activate', controlId: 'information-actions', actionId: 'refresh', pagePath: [] }, {
        surfaceId: overlay.id, source: [], signal: new AbortController().signal, revision: overlay.revision, operationId: 'refresh', report: vi.fn(),
      })
      current = undefined
      old()
      expect(ctx.mayflyOverlays.list()).toEqual([])
      expect(listeners.size).toBe(0)
      old()
      expect(ctx.mayflyOverlays.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('paints help, version, diagnostics and shared usage within narrow and wide native viewports', async () => {
    const { ctx, panels } = await fixture()
    const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
    const components = new MayflyComponentsService(ctx, { theme: { colors }, tui: { requestRender: () => {} } } as unknown as MayflyComponentsDeps)
    const context: RemoteSessionUsageFacts = {
      model: { model: '长模型😀'.repeat(8), provider: 'native-provider' },
      usage: { buckets: { input: 100, cacheRead: 50, cacheWrite: 10, output: 200 }, context: { used: 1500, window: 2048 } },
      composition: { system: 100, tools: 200, messages: 1200 },
    }
    try {
      const show = [
        () => { panels.showHelp([{ name: 'sessions', description: '会话😀'.repeat(30), aliases: ['resume'] }, { name: 'attach', description: 'Connect a Host URL', group: 'remote' }]) },
        () => { panels.showVersion('0.2.2-alpha.2') },
        () => { panels.showChangelog() },
        () => { panels.showStatus(facts) },
        () => { panels.showContext({ read: () => context, subscribe: () => () => {} }) },
      ]
      for (const open of show) {
        open()
        const node = ctx.mayflyOverlays.list()[0]!.node!
        for (const width of [1, 8, 20, 40, 80, 160]) {
          const compiled = compileMayflyUiNode(node, { emit: () => {}, components, colors, getViewport: () => ({ columns: width, rows: 40 }), screenMode: 'alternate' })
          if (!compiled.ok) throw new Error(compiled.message)
          for (const line of compiled.value.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        }
      }
    } finally { await ctx.fiber.dispose() }
  })
})

it('shows the shared rewind picker, fences replaced choices and retires it with its exact source', async () => {
  const { ctx, panels, text } = await fixture()
  let current = true
  let changed: (() => void) | undefined
  const off = vi.fn()
  const choose = vi.fn(async () => {})
  const candidates = [{ turn: 1, boundarySeq: 2, prompt: 'Earlier prompt', response: 'Earlier answer', discarded: 2 }]
  const open = () => { panels.showRewind(candidates, choose, () => current, listener => { changed = listener; return off }) }
  try {
    open()
    expect(text()).toContain('Rewind current session')
    expect(text()).toContain('Earlier prompt')
    const entry = ctx.mayflyOverlays.list()[0]!
    const context = { surfaceId: entry.id, source: [], signal: new AbortController().signal, revision: entry.revision, operationId: 'choose', report: vi.fn() }
    await entry.events.prepare({ kind: 'activate', controlId: 'rewind-candidates', actionId: 'other', pagePath: [] }, context)
    await entry.events.prepare({ kind: 'selection-accept', controlId: 'rewind-candidates', selectedIds: ['missing'], pagePath: [] }, context)
    expect(choose).not.toHaveBeenCalled()
    await entry.events.prepare({ kind: 'selection-accept', controlId: 'rewind-candidates', selectedIds: ['2'], pagePath: [] }, context)
    expect(choose).toHaveBeenCalledWith(2)
    open()
    current = false
    const stale = ctx.mayflyOverlays.list()[0]!
    await stale.events.prepare({ kind: 'selection-accept', controlId: 'rewind-candidates', selectedIds: ['2'], pagePath: [] }, { ...context, surfaceId: stale.id, revision: stale.revision })
    expect(choose).toHaveBeenCalledOnce()
    current = true
    open()
    changed?.()
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
    current = false
    changed?.()
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
    expect(off).toHaveBeenCalled()
  } finally { panels.dispose(); await ctx.fiber.dispose() }
})
