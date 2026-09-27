/**
 * `dsh-schedule` is a Host-level durable service in this Harness line, not a
 * preset-scoped mount. Mounting it once attaches `schedule_*` tools to every
 * root Agent, including Agents composed under presets that carry no Schedule
 * row of their own; Agent disposal detaches them again.
 * @module @ephemeral-ai/mayfly/tests/schedule-preset
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { mkdtempTracked, registerTempDirCleanup } from './core/temp-dir.ts'

registerTempDirCleanup()

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: mkdtempTracked('mayfly-schedule-preset-') })
  ctx.on('session/flush', () => {})
  // The real service only needs the domain to open once; a memory table keeps
  // the Agent-attachment contract under test without a storage backend.
  const table = { entries: () => [] as never[], put: async () => {}, delete: async () => {} }
  ctx.provide('storageDomain', { open: async () => ({ table: () => table, close: async () => {} }) } as never)
  ctx.provide('sessionController', { resolveAgent: vi.fn(async () => { throw new Error('missing Session') }) } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('Host-wide Schedule mount', () => {
  it('registers reminder tools for every root Agent and detaches them on disposal', async () => {
    const ctx = await harness()
    await ctx.plugin(ScheduleService, {})

    const first = await ctx.agents.create({ sessionId: SessionId('schedule-first') })
    const second = await ctx.agents.create({ sessionId: SessionId('schedule-second') })
    for (const agent of [first.agent, second.agent]) {
      expect(ctx.tools.get('schedule_create', agent)?.name).toBe('schedule_create')
      expect(ctx.tools.get('schedule_list', agent)?.name).toBe('schedule_list')
      expect(ctx.tools.get('schedule_delete', agent)?.name).toBe('schedule_delete')
      expect(ctx.tools.get('schedule_update', agent)?.name).toBe('schedule_update')
    }
    // The tools stay scoped to Agents: no global registration leaks.
    expect(ctx.tools.get('schedule_create')).toBeUndefined()
    expect(await ctx.schedule.catalog()).toEqual([])

    await first.dispose()
    expect(ctx.tools.get('schedule_create', first.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_create', second.agent)?.name).toBe('schedule_create')

    await second.dispose()
    await ctx.fiber.dispose()
  })
})
