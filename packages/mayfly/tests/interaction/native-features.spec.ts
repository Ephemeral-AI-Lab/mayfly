import { nativeAction, activate, select as selection } from './native-action-fixture.ts'
/** Native Team and reminder projections stay readonly and follow selection.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-features
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import * as team from '../../src/interaction/team-command.ts'
import * as schedule from '../../src/interaction/schedule-command.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests as flushOneRequest, renderRequest } from './request-fixture.ts'
import { SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const flushRequests = async () => { await flushOneRequest(); await flushOneRequest() }
const contexts: Context[] = []
afterEach(async () => { vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const projection = (): TeamProjection => ({ members: [
  { id: 'current' as never, name: 'lead', role: 'lead', phase: 'active' },
  { id: 'other' as never, name: 'reviewer', role: 'teammate', phase: 'active' },
  { id: 'cold' as never, name: 'cold', role: 'teammate', phase: 'active' },
  { id: 'failed' as never, name: 'failed', role: 'teammate', phase: 'failed', error: 'provider failed' },
  { id: 'starting' as never, name: 'starting', role: 'teammate', phase: 'provisioning' },
], tasks: [
  { id: '1' as never, revision: 1, subject: 'Review', description: 'Review all changes', status: 'pending', ownerName: 'reviewer', ready: false, blockedBy: ['2' as never], writeScopes: ['src/**'], writeScopeWarnings: ['Overlaps another task'] },
  { id: '2' as never, revision: 1, subject: 'Implement', description: '', status: 'completed', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
  { id: '3' as never, revision: 1, subject: 'Ready', description: '', status: 'pending', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
] })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  let teamValue: TeamProjection | undefined = projection()
  const changed: ((session: unknown, key: string) => void)[] = []
  vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation(callback => { changed.push(callback as never); return () => {} })
  let schedules: readonly ScheduleRecord[] | undefined
  vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => ({ asOfSeq: 0, values: { agentTeam: teamValue, schedule: schedules, modelSelection: { next: { model: 'test-model' } } } }) as never)
  const teamFiber = await ctx.plugin(team)
  const scheduleFiber = await ctx.plugin(schedule)
  return { ...bench, changed, teamFiber, scheduleFiber, setTeam: (value: TeamProjection | undefined) => { teamValue = value }, setSchedule: (value: readonly ScheduleRecord[] | undefined) => { schedules = value } }
}
it('shows the official readonly Team board and opens eligible member conversations', async () => {
  const bench = await setup()
  await bench.run('/team')
  let model = bench.model('mayfly.team')
  expect(JSON.stringify(model.node)).toContain('blocked')
  expect(JSON.stringify(model.node)).toContain('test-model')
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'team-tasks', selectedIds: ['1'] })
  await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.team.task').node)).toContain('Overlaps another task')
  bench.model('mayfly.team.task').requestClose()
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'team-members', selectedIds: ['other'] })
  await flushRequests()
  expect(bench.ctx.mayflyCurrentAgent.current()).toBe(bench.other)
  await bench.run('/team')
  model = bench.model('mayfly.team')
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'team-members', selectedIds: ['current'] })
  await flushRequests()
  expect(bench.ctx.mayflyCurrentAgent.current()).toBe(bench.agent)
  await bench.run('/team')
  bench.model('mayfly.team').emit({ kind: 'selection-accept', pagePath: [], controlId: 'team-members', selectedIds: ['cold'] })
  await flushRequests()
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary?.access).toBe('resumable')
})
it('keeps projection failure visible, contains unavailable state, and fits narrow widths', async () => {
  const bench = await setup()
  bench.setTeam({ ...projection(), failure: 'Rejected persisted record' })
  await bench.run('/team')
  const model = bench.model('mayfly.team')
  expect(JSON.stringify(model.node)).toContain('Rejected persisted record')
  for (const width of SCAN_WIDTHS) {
    const renderer = renderRequest(model, { columns: width, rows: 24 })
    expectLinesFit('native-feature', renderer.component.render(width), width)
    renderer.runtime.dispose()
  }
  bench.setTeam(undefined)
  bench.ctx.emit('agent/status', { agent: bench.agent } as never)
  expect(JSON.stringify(model.node)).toContain('Team unavailable')
  bench.ctx.mayflyCurrentAgent.select(null)
  expect(model.disposed).toBe(true)
  await bench.teamFiber.dispose()
  expect(bench.ctx.mayflyStatus.list().some(item => item.id === 'mayfly.team')).toBe(false)
})
it('shows reminder timing without loading bodies or creating its own delivery runtime', async () => {
  const bench = await setup()
  await bench.run('/schedule')
  expect(JSON.stringify(bench.model('mayfly.schedule').node)).toContain('Schedule unavailable')
  bench.setSchedule([
    { id: 'late', prompt: 'Check the build', kind: 'after', scheduledAt: '2020-01-01T00:00:00Z' },
    { id: 'repeat', prompt: 'Repeat', kind: 'every', everySeconds: 300, scheduledAt: '2099-01-01T00:00:00Z' },
  ] as never)
  await bench.run('/schedule')
  const model = bench.model('mayfly.schedule')
  const text = JSON.stringify(model.node)
  expect(text).toContain('overdue')
  expect(text).toContain('every 300s')
  expect(text).toContain('live root session')
  for (const width of SCAN_WIDTHS) {
    const renderer = renderRequest(model, { columns: width, rows: 24 })
    expectLinesFit('native-feature', renderer.component.render(width), width)
    renderer.runtime.dispose()
  }
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  expect(model.disposed).toBe(true)
  await bench.scheduleFiber.dispose()
})

it('contains unavailable selections and refreshes native projection/status notifications', async () => {
  const bench = await setup()
  await bench.run('/team')
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.team')!
  expect(await nativeAction(model, activate('unknown'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(model, selection('team-tasks', 'missing'))).toMatchObject({ kind: 'cancelled' })
  expect(await nativeAction(model, selection('team-members', 'failed'))).toMatchObject({ kind: 'cancelled' })
  expect(await nativeAction(model, selection('team-members'))).toMatchObject({ kind: 'cancelled' })
  await nativeAction(model, selection('team-tasks', '2'))
  const task = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.team.task')!
  expect(await nativeAction(task, activate('close'))).toMatchObject({ kind: 'completed' })
  bench.ctx.emit('agent/created', { agent: bench.other } as never)
  bench.ctx.emit('agent/disposed', { agent: bench.other } as never)
  Object.assign(bench.other, { status: 'running' })
  for (const callback of bench.changed) { callback(bench.session, 'agentTeam'); callback(bench.otherSession, 'modelSelection'); callback(bench.otherSession, 'other'); callback(bench.session, 'schedule'); callback(bench.otherSession, 'schedule') }
  bench.session.append('turn/start', { turn: 1 }); await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.team')
  await bench.run('/schedule')
  const reminders = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.schedule')!
  expect(await nativeAction(reminders, activate('close'))).toMatchObject({ kind: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 1010))
  bench.ctx.mayflyCurrentAgent.select(null)
  expect(reminders.disposed).toBe(true)
})
it('updates an open task detail from native projection changes and closes a removed task', async () => {
  const bench = await setup()
  await bench.run('/team')
  const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.team')!
  await nativeAction(model, selection('team-tasks', '1'))
  const detail = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.team.task')!
  const next = projection()
  bench.setTeam({ ...next, tasks: next.tasks.map(task => ({ ...task, description: 'New authoritative description' })) })
  bench.changed.forEach(callback => callback(bench.session, 'agentTeam'))
  expect(JSON.stringify(detail.node)).toContain('New authoritative description')
  bench.setTeam(undefined)
  bench.changed.forEach(callback => callback(bench.session, 'agentTeam'))
  expect(detail.disposed).toBe(true)
})
