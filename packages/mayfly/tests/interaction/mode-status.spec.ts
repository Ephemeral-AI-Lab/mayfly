/** Native plan and permission-backed mode status tests.
 * @module @ephemeral-ai/mayfly/interaction/tests/mode-status
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as modeStatus from '../../src/interaction/mode-status.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'

type PlanState = { active: boolean, pending?: boolean }

async function mount(initial: PlanState = { active: false }, withPlan = true) {
  const { ctx } = fakeMayflyContext()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('mode-status-spec'))
  const states = new Map<Agent, PlanState>()
  const permissions = new Map<Agent, string>()
  const agents = new Map<typeof session, Agent>()
  const agentFor = (target: typeof session): Agent => {
    const agent = { id: target.id, session: target, status: 'idle' } as unknown as Agent
    agents.set(target, agent)
    permissions.set(agent, 'workspace-write')
    return agent
  }
  const agent = agentFor(session)
  states.set(agent, initial)
  vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(target => {
    const selected = agents.get(target as typeof session)
    const state = selected === undefined ? undefined : states.get(selected)
    return {
      asOfSeq: target.seq - 1,
      values: !withPlan || state === undefined
        ? {}
        : { plan: { active: state.active, pending: state.pending === true } },
    }
  })
  ctx.provide('permissionPresets', {
    names: ['workspace-write', 'danger-full-access'],
    current: target => permissions.get(agents.get(target as typeof session)!) ?? 'workspace-write',
    resolve: name => name === 'danger-full-access'
      ? { sandbox: 'danger-full-access', approval: 'never' }
      : { sandbox: 'workspace-write', approval: 'ask' },
    optionOf: name => ({ value: name, name }),
  } satisfies PermissionPresetsService as never)
  ctx.provide('testSession', { current: agent })
  const fiber = await ctx.plugin(modeStatus)
  const entry = () => ctx.mayflyStatus.list().find(value => value.id === 'mayfly.status.mode')
  return { ctx, agent, agentFor, states, permissions, fiber, entry }
}

describe('mayfly-status-mode', () => {
  it('registers native normal, plan, pending, and yolo states at priority 2', async () => {
    const normal = await mount()
    expect(normal.entry()).toMatchObject({ definition: { priority: 2 }, node: null })

    const active = await mount({ active: true })
    expect(active.entry()).toMatchObject({ node: { kind: 'text', content: 'plan', tone: 'accent' } })

    const pending = await mount({ active: true, pending: true })
    expect(pending.entry()?.node).toMatchObject({ content: 'plan...' })

    active.permissions.set(active.agent, 'danger-full-access')
    active.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    expect(active.entry()).toMatchObject({ node: { content: 'yolo', tone: 'warning' } })
  })

  it('refreshes from the current Session event stream', async () => {
    const world = await mount()
    const revision = world.entry()?.node
    const other = world.ctx.sessions.create(SessionId('mode-status-other'))
    other.append('plan/mode', { active: true })
    expect(world.entry()?.node).toEqual(revision)
    world.states.set(world.agent, { active: true })
    world.agent.session.append('plan/mode', { active: true })
    expect(world.entry()?.node).toMatchObject({ content: 'plan' })
  })

  it('follows exact current-Agent changes', async () => {
    const world = await mount({ active: true })
    const nextSession = world.ctx.sessions.create(SessionId('mode-status-next'))
    const next = world.agentFor(nextSession)
    ;(world.ctx.get('testSession') as { current: Agent | null }).current = next
    world.ctx.emit('test/session-changed', next)
    expect(world.entry()).toMatchObject({ node: null })

    world.states.set(next, { active: true })
    next.session.append('plan/mode', { active: true })
    expect(world.entry()?.node).toMatchObject({ content: 'plan' })
  })

  it('hides with no current Agent and unregisters on unload', async () => {
    const world = await mount({ active: true })
    ;(world.ctx.get('testSession') as { current: Agent | null }).current = null
    world.ctx.emit('test/session-changed', null)
    expect(world.entry()?.node).toBeNull()
    await world.fiber.dispose()
    expect(world.entry()).toBeUndefined()
  })

  it('hides when the plan projection is absent and permissions are normal', async () => {
    const world = await mount({ active: true }, false)
    expect(world.entry()).toMatchObject({ node: null })
  })
})
