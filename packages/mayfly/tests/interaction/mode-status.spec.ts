/** Native plan and permission projection-backed mode status tests.
 * @module @ephemeral-ai/mayfly/interaction/tests/mode-status
 */

import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as modeStatus from '../../src/interaction/mode-status.ts'
import { compileMayflyStatusNode } from '../../src/core/ui-compiler.ts'
import { SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from '../../src/core/width.ts'
import type { PermissionPresetsService } from '../../src/interaction/permission-panel.ts'
import { fakeMayflyContext } from './fakes.ts'
import { plainColors } from '../helpers.ts'

/** The native plan/permission projection face: values per Session and one change feed. */
class ModeProjectionFake {
  private readonly plans = new Map<object, PlanProjection>()
  private readonly permissions = new Map<object, PermissionSelection>()
  private readonly listeners = new Set<(session: unknown, key: string, value: unknown, seq: number) => void>()
  reads = 0

  setPlan(session: object, plan: PlanProjection): void {
    this.plans.set(session, plan)
    this.publish(session, 'plan', plan)
  }

  setPermission(session: object, currentValue: string): void {
    const value = { currentValue }
    this.permissions.set(session, value)
    this.publish(session, 'permissions', value)
  }

  setPermissionQuietly(session: object, currentValue: string): void {
    this.permissions.set(session, { currentValue })
  }

  snapshot(session: object, keys?: readonly string[]): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    this.reads += 1
    const plan = this.plans.get(session)
    const permission = this.permissions.get(session)
    return {
      asOfSeq: 0,
      values: {
        ...plan === undefined || (keys !== undefined && !keys.includes('plan')) ? {} : { plan },
        ...permission === undefined || (keys !== undefined && !keys.includes('permissions')) ? {} : { permissions: permission },
      },
    }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish a change for another key, which the badges must ignore. */
  publishOther(session: object, key: string, value: unknown): void {
    this.publish(session, key, value)
  }

  private publish(session: object, key: string, value: unknown): void {
    for (const listener of this.listeners) listener(session, key, value, 0)
  }
}

async function mount(initial: PlanProjection = { active: false, pending: false }, withPlan = true) {
  const projections = new ModeProjectionFake()
  const { ctx } = fakeMayflyContext({ projections })
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('mode-status-spec'))
  if (withPlan) projections.setPlan(session, initial)
  const agentFor = (target: typeof session): Agent => {
    const agent = { id: target.id, session: target, status: 'idle' } as unknown as Agent
    projections.setPermissionQuietly(target, 'workspace-write')
    return agent
  }
  const agent = agentFor(session)
  ctx.provide('permissionPresets', {
    names: ['workspace-write', 'danger-full-access'],
    current: () => 'workspace-write',
    resolve: name => {
      if (name === 'danger-full-access') return { sandbox: 'danger-full-access', approval: 'never' }
      if (name === 'ask-full') return { sandbox: 'danger-full-access', approval: 'ask' }
      if (name === 'alias') return { sandbox: 'danger-full-access', approval: 'never' }
      if (name === 'workspace-write') return { sandbox: 'workspace-write', approval: 'ask' }
      throw new Error(`unknown preset ${name}`)
    },
    optionOf: name => ({ value: name, name }),
  } satisfies PermissionPresetsService as never)
  ctx.provide('testSession', { current: agent })
  const fiber = await ctx.plugin(modeStatus)
  const entry = () => ctx.mayflyStatus.list().find(value => value.id === 'mayfly.status.mode')
  const switchTo = (next: Agent | null): void => {
    ;(ctx.get('testSession') as { current: Agent | null }).current = next
    ctx.emit('test/session-changed', next)
  }
  return { ctx, agent, agentFor, projections, fiber, entry, switchTo }
}

describe('mayfly-status-mode', () => {
  it('registers native normal, plan, pending, and yolo states at priority 2', async () => {
    const normal = await mount()
    expect(normal.entry()).toMatchObject({ definition: { priority: 2 }, node: null })

    const active = await mount({ active: true, pending: false })
    expect(active.entry()).toMatchObject({ node: { kind: 'text', content: 'plan', tone: 'accent' } })

    const pending = await mount({ active: true, pending: true })
    expect(pending.entry()?.node).toMatchObject({ content: 'plan…' })

    normal.projections.setPermission(normal.agent.session, 'danger-full-access')
    expect(normal.entry()).toMatchObject({ node: { content: 'yolo', tone: 'warning' } })
  })

  it.each([false, true])('renders both badges with pending=%s and preserves yolo when planning ends', async pending => {
    const world = await mount({ active: true, pending })
    world.projections.setPermission(world.agent.session, 'danger-full-access')
    const node = world.entry()!.node!
    expect(node).toEqual({ kind: 'stack', direction: 'row', gap: 1, children: [
      { node: { kind: 'text', content: pending ? 'plan…' : 'plan', tone: 'accent' } },
      { node: { kind: 'text', content: 'yolo', tone: 'warning' } },
    ] })
    const compiled = compileMayflyStatusNode(node, {
      components: { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as never,
      colors: plainColors() as never,
      getViewport: () => ({ columns: 80, rows: 1 }),
      screenMode: 'main', maxRows: 1,
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('mode status compilation failed')
    expect(stripVTControlCharacters(compiled.value.component.render(20).join('')).trim()).toBe(pending ? 'plan… yolo' : 'plan yolo')
    for (const width of SCAN_WIDTHS) expectLinesFit('plan-yolo-status', compiled.value.component.render(width), width)

    world.projections.setPlan(world.agent.session, { active: false, pending: true })
    expect(world.entry()?.node).toMatchObject({ children: [{ node: { content: 'plan…' } }, { node: { content: 'yolo' } }] })
    world.projections.setPlan(world.agent.session, { active: false, pending: false })
    expect(world.entry()?.node).toEqual({ kind: 'text', content: 'yolo', tone: 'warning' })
  })

  it('refreshes from the exact Session\'s plan and permission projection changes only', async () => {
    const world = await mount({ active: true, pending: false })
    const other = world.ctx.sessions.create(SessionId('mode-status-other'))
    world.agentFor(other)
    const baseline = world.projections.reads
    // A change on another Session is not this badge's.
    world.projections.setPlan(other, { active: true, pending: false })
    expect(world.projections.reads).toBe(baseline)
    expect(world.entry()?.node).toMatchObject({ content: 'plan' })
    // A non-mode key on the current Session does not re-read either.
    world.projections.publishOther(world.agent.session, 'turnOutline', [])
    expect(world.projections.reads).toBe(baseline)
    // The mode keys do.
    world.projections.setPlan(world.agent.session, { active: false, pending: false })
    expect(world.projections.reads).toBe(baseline + 1)
    expect(world.entry()?.node).toBeNull()
    world.projections.setPermission(world.agent.session, 'danger-full-access')
    expect(world.projections.reads).toBe(baseline + 2)
    expect(world.entry()?.node).toMatchObject({ content: 'yolo' })
  })

  it('derives yolo from the selected preset bundle, not its name', async () => {
    const world = await mount()
    world.projections.setPermission(world.agent.session, 'alias')
    expect(world.entry()?.node).toMatchObject({ content: 'yolo' })
    world.projections.setPermission(world.agent.session, 'ask-full')
    expect(world.entry()?.node).toBeNull()
    world.projections.setPermission(world.agent.session, 'custom')
    expect(world.entry()?.node).toBeNull()
  })

  it('follows exact current-Agent changes', async () => {
    const world = await mount({ active: true, pending: false })
    const nextSession = world.ctx.sessions.create(SessionId('mode-status-next'))
    const next = world.agentFor(nextSession)
    world.switchTo(next)
    expect(world.entry()).toMatchObject({ node: null })

    world.projections.setPlan(nextSession, { active: true, pending: false })
    expect(world.entry()?.node).toMatchObject({ content: 'plan' })
    world.switchTo(null)
    expect(world.entry()?.node).toBeNull()
    await world.fiber.dispose()
    expect(world.entry()).toBeUndefined()
  })

  it('hides when the plan projection is absent and permissions are normal', async () => {
    const world = await mount({ active: true, pending: false }, false)
    expect(world.entry()).toMatchObject({ node: null })
    world.projections.setPermission(world.agent.session, 'danger-full-access')
    expect(world.entry()?.node).toEqual({ kind: 'text', content: 'yolo', tone: 'warning' })
  })
})
