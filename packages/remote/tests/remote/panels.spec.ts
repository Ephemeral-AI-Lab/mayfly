/** Headless command overlay ownership through the real shared provider. @module tests/remote/panels */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { RemotePlainPanels } from '../../src/remote/interactions/plain-panels.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  ctx.provide('mayflyKeymap', { list: () => [{ id: 'test', keys: 'ctrl+k', description: 'Test key' }] } as never)
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
      panels.showHelp([{ name: 'quit', description: 'Exit Mayfly' }])
      expect(text()).toContain('/quit (/q, /exit)')
      expect(text()).toContain('Panels and pickers')
      expect(text()).toContain('Test key')
      expect(ctx.mayflyOverlays.list()[0]!.definition.presentation).toBe('editor')
      panels.showVersion()
      expect(ctx.mayflyOverlays.list()).toHaveLength(1)
      expect(text()).toContain('Mayfly v')
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
      expect(text()).toContain('Mayfly v')
      await current.events.prepare(event, { ...eventContext, surfaceId: current.id, revision: current.revision })
      expect(ctx.mayflyOverlays.list()).toEqual([])
      const registry = ctx.mayflyOverlays
      await ctx.fiber.dispose()
      expect(registry.list()).toEqual([])
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
})
