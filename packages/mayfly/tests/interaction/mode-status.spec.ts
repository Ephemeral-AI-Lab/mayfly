/** Native plan and permission-backed mode status tests.
 * @module @ephemeral-ai/mayfly/interaction/tests/mode-status
 */

import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as modeStatus from '../../src/interaction/mode-status.ts'
import { compileMayflyStatusNode } from '../../src/core/ui-compiler.ts'
import { SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from '../../src/core/width.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'

type PlanState = { active: boolean, pending?: boolean }

async function mount(initial: PlanState = { active: false }, withPlan = true, ordered = false) {
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
  // Mirrors dsh `derive()`: a recorded preset is effective only once the
  // sandbox and approval knobs folded so far match its spec.
  const knobs = { preset: null as string | null, sandbox: 'workspace-write', approval: 'ask' }
  ctx.on('session/event', (_target, event) => {
    const data = event.data as Record<string, string>
    if (event.type === 'permission/preset') knobs.preset = data['preset']!
    if (event.type === 'sandbox/mode') knobs.sandbox = data['mode']!
    if (event.type === 'approval/policy') knobs.approval = data['policy']!
  })
  const derived = (): string => {
    if (knobs.preset !== null) {
      const spec = knobs.preset === 'danger-full-access'
        ? { sandbox: 'danger-full-access', approval: 'never' }
        : { sandbox: 'workspace-write', approval: 'ask' }
      if (spec.sandbox === knobs.sandbox && spec.approval === knobs.approval) return knobs.preset
    }
    return knobs.sandbox === 'danger-full-access' && knobs.approval === 'never' ? 'danger-full-access' : 'workspace-write'
  }
  ctx.provide('permissionPresets', {
    names: ['workspace-write', 'danger-full-access'],
    current: target => ordered ? derived() : permissions.get(agents.get(target as typeof session)!) ?? 'workspace-write',
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
    expect(pending.entry()?.node).toMatchObject({ content: 'plan…' })

    normal.permissions.set(normal.agent, 'danger-full-access')
    normal.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    expect(normal.entry()).toMatchObject({ node: { content: 'yolo', tone: 'warning' } })
  })

  it.each([false, true])('renders both badges with pending=%s and preserves yolo when planning ends', async pending => {
    const world = await mount({ active: true, pending })
    world.permissions.set(world.agent, 'danger-full-access')
    world.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    const node = world.entry()!.node!
    expect(node).toEqual({ kind: 'stack', direction: 'row', gap: 1, children: [
      { node: { kind: 'text', content: pending ? 'plan…' : 'plan', tone: 'accent' } },
      { node: { kind: 'text', content: 'yolo', tone: 'warning' } },
    ] })
    const identity = (text: string) => text
    const compiled = compileMayflyStatusNode(node, {
      components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as never,
      colors: new Proxy({}, { get: () => identity }) as never,
      getViewport: () => ({ columns: 80, rows: 1 }),
      screenMode: 'main', maxRows: 1,
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('mode status compilation failed')
    expect(stripVTControlCharacters(compiled.value.component.render(20).join('')).trim()).toBe(pending ? 'plan… yolo' : 'plan yolo')
    for (const width of SCAN_WIDTHS) expectLinesFit('plan-yolo-status', compiled.value.component.render(width), width)

    world.states.set(world.agent, { active: false, pending: true })
    world.agent.session.append('plan/mode', { active: false })
    expect(world.entry()?.node).toMatchObject({ children: [{ node: { content: 'plan…' } }, { node: { content: 'yolo' } }] })
    world.states.set(world.agent, { active: false })
    world.agent.session.append('plan/mode', { active: false })
    expect(world.entry()?.node).toEqual({ kind: 'text', content: 'yolo', tone: 'warning' })
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

  it('skips non-mode session facts: stream deltas never re-read the projections', async () => {
    const world = await mount({ active: true })
    const snapshots = world.ctx.sessionProjections.snapshot as unknown as { mock: { calls: unknown[] } }
    const reads = () => snapshots.mock.calls.length
    const baseline = reads()
    // A turn fact (or any non-plan, non-permission event, stream deltas
    // included) cannot change the badges, so it never reaches refresh().
    world.agent.session.append('turn/start', { turn: 1 })
    expect(reads()).toBe(baseline)
    expect(world.entry()?.node).toMatchObject({ content: 'plan' })
    // A permission fact still refreshes immediately.
    world.permissions.set(world.agent, 'danger-full-access')
    world.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    expect(reads()).toBe(baseline + 1)
    expect(world.entry()?.node).toMatchObject({ children: [{ node: { content: 'plan' } }, { node: { content: 'yolo' } }] })
  })

  describe('preset switches fold their knob facts after the preset fact', () => {
    const yolo = { kind: 'text', content: 'yolo', tone: 'warning' }

    it('shows yolo only once the final knob fact lands, and clears on leaving', async () => {
      const world = await mount({ active: false }, true, true)
      const session = world.agent.session
      session.append('permission/preset', { preset: 'danger-full-access' })
      expect(world.entry()?.node).toBeNull()
      session.append('sandbox/mode', { mode: 'danger-full-access' })
      expect(world.entry()?.node).toBeNull()
      session.append('approval/policy', { policy: 'never' })
      expect(world.entry()?.node).toEqual(yolo)

      session.append('permission/preset', { preset: 'workspace-write' })
      expect(world.entry()?.node).toEqual(yolo)
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
      expect(world.entry()?.node).toBeNull()
    })

    it('shows yolo when the last changed knob is the sandbox', async () => {
      const world = await mount({ active: false }, true, true)
      const session = world.agent.session
      session.append('approval/policy', { policy: 'never' })
      session.append('permission/preset', { preset: 'danger-full-access' })
      expect(world.entry()?.node).toBeNull()
      session.append('sandbox/mode', { mode: 'danger-full-access' })
      expect(world.entry()?.node).toEqual(yolo)
    })

    it('follows a queued plan through its command lifecycle', async () => {
      const world = await mount({ active: false }, true, true)
      const session = world.agent.session
      world.states.set(world.agent, { active: false, pending: true })
      session.append('command/run', { commandId: 'c1', name: 'plan' })
      expect(world.entry()?.node).toMatchObject({ content: 'plan…' })
      world.states.set(world.agent, { active: false })
      session.append('command/done', { commandId: 'c1', kind: 'success' })
      expect(world.entry()?.node).toBeNull()
    })
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
    world.permissions.set(world.agent, 'danger-full-access')
    world.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    expect(world.entry()?.node).toEqual({ kind: 'text', content: 'yolo', tone: 'warning' })
  })
})
