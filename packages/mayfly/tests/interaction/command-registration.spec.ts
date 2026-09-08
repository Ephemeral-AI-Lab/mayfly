/** Command dependencies and registry replacement through actual Cordis Fibers.
 * @module @ephemeral-ai/mayfly/tests/interaction/command-registration
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import * as commands from '../../src/interaction/commands-plugin.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'

const roots: Context[] = []
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
afterEach(async () => { for (const ctx of roots.splice(0).reverse()) await ctx.fiber.dispose() })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('command-lifecycle'))
  const agent = { id: session.id, session, status: 'idle' } as Agent
  ctx.provide('mayflyCurrentAgent', {
    current: () => null,
    primary: () => null,
    revision: () => 0,
    subscribe(listener: (agent: Agent | null, revision: number) => void) { listener(null, 0); return () => {} },
  } as never)
  ctx.provide('skills', { snapshot: async () => ({ complete: true, skills: [] }) } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} } as never)
  ctx.provide('sessionController', {} as never)
  ctx.provide('tools', { schemas: () => [] } as never)
  await ctx.plugin({ name: 'test-interaction-state', apply(owner: Context) { new InteractionStateService(owner, DEFAULT_SETTINGS) } })
  await ctx.plugin(frontend)
  const consumer = await ctx.plugin(commands)
  await flush()
  return { ctx, agent, consumer }
}

describe('command registration ownership', () => {
  it('waits for the overlay provider and registers without a renderer', async () => {
    const { ctx, agent } = await setup()
    expect(ctx.commands.find(agent, 'quit')).toBeUndefined()
    const retained = ctx.mayflyUiInteraction.upsert('editor-panel', {
      id: 'retained', node: { kind: 'text', content: 'retained' }, revision: 0,
      source: [], scope: { kind: 'app', targetId: 'retained' }, update: { reason: 'data' }, definition: {},
      events: { prepare: async () => ({ reply: undefined, publish: () => false }) },
    })
    await ctx.plugin(uiProvider)
    await flush()
    expect(ctx.get('mayflyScreen')).toBeUndefined()
    expect(ctx.commands.find(agent, 'quit')).toBeDefined()
    expect(ctx.commands.find(agent, 'trace')).toBeDefined()
    expect(ctx.mayflyUiInteraction.get('editor-panel', 'retained')).toBe(retained)
  })

  it('retires all dependent commands and restores one registration after provider replacement', async () => {
    const { ctx, agent, consumer } = await setup()
    const provider = await ctx.plugin(uiProvider)
    await flush()
    const first = ctx.commands.find(agent, 'trace')
    expect(first).toBeDefined()
    ctx.mayflySkillsCatalog.setForTest([])
    await provider.dispose()
    await flush()
    expect(ctx.commands.find(agent, 'trace')).toBeUndefined()
    expect(ctx.commands.find(agent, 'quit')).toBeUndefined()
    expect(ctx.mayflySkillsCatalog.snapshot()).toEqual({ skills: [], complete: true })
    await ctx.plugin(uiProvider)
    await flush()
    expect(ctx.commands.find(agent, 'trace')).toBeDefined()
    expect(ctx.commands.find(agent, 'trace')).not.toBe(first)
    await consumer.dispose()
    expect(ctx.commands.find(agent, 'trace')).toBeUndefined()
    expect(ctx.get('mayflyOverlays')).toBeDefined()
  })
})
