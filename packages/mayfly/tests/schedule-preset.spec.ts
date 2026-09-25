/**
 * The standard preset mounts `dsh-schedule` inside its standing scope, so the
 * capability's `agent/created` listener observes only Agents composed under
 * that preset. Agents outside the scope keep no schedule_* tools, which is
 * what keeps minimal and the other shipped presets clean.
 * @module @ephemeral-ai/mayfly/tests/schedule-preset
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { bindScopeParent, createScope, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as schedulePlugin from '@deepseek-ai/dsh-schedule'
import { mkdtempTracked, registerTempDirCleanup } from './core/temp-dir.ts'

registerTempDirCleanup()

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: mkdtempTracked('mayfly-schedule-preset-') })
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('preset-scoped Schedule mount', () => {
  it('registers reminder tools only for Agents under the standing preset scope', async () => {
    const ctx = await harness()
    // Mirror agent-presets: the standing mount owns a scope key and each
    // Agent's key is bound to it inside setup, before agent/created fires.
    const presetKey: ScopeKey = { agentPreset: 'standard' }
    const standing = createScope(ctx, presetKey)
    await standing.ctx.plugin(schedulePlugin)

    const outside = await ctx.agents.create({ sessionId: SessionId('schedule-outside') })
    expect(ctx.tools.get('schedule_create', outside.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_list', outside.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_delete', outside.agent)).toBeUndefined()

    const inside = await ctx.agents.create({
      sessionId: SessionId('schedule-inside'),
      setup: agentCtx => {
        const key = scopeOf(agentCtx)
        if (key === undefined) throw new Error('agent setup must carry a scope key')
        bindScopeParent(key, presetKey)
      },
    })
    expect(ctx.tools.get('schedule_create', inside.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', inside.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_delete', inside.agent)?.name).toBe('schedule_delete')
    // The tools stay scoped to the Agent: no global registration leaks.
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    await inside.dispose()
    await outside.dispose()
    await standing.dispose()
    await ctx.fiber.dispose()
  })
})
