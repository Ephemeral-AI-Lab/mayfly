/** Native Host Schedule reads follow the selected Agent without owning delivery.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-features
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScheduleListRequest, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import * as schedule from '../../src/interaction/schedule-command.ts'
import { informationFixture } from './information-fixture.ts'
import { nativeAction, activate } from './native-action-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'
import { SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(options: { schedule?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  let schedules: ScheduleRecord[] = []
  const list = vi.fn(async (_request: ScheduleListRequest) => schedules)
  if (options.schedule !== false) ctx.provide('schedule', { list } as never)
  let toolNames: () => readonly string[] = () => ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update']
  ctx.provide('tools', { schemas: () => toolNames().map(name => ({ name })) } as never)
  const scheduleFiber = await ctx.plugin(schedule)
  return { ...bench, scheduleFiber, list, setSchedule: (value: ScheduleRecord[]) => { schedules = value }, setTools: (names: () => readonly string[]) => { toolNames = names } }
}
it('shows reminder timing without loading bodies or creating its own delivery runtime', async () => {
  const unavailable = await setup({ schedule: false })
  await unavailable.run('/schedule')
  await flushRequests()
  expect(JSON.stringify(unavailable.model('mayfly.schedule').node)).toContain('Schedule unavailable')
  const bench = await setup()
  await bench.run('/schedule')
  bench.setTools(() => [])
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.schedule').node)).toContain('Schedule unavailable')
  bench.setTools(() => { throw new Error('tool view unavailable') })
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.schedule').node)).toContain('Schedule unavailable')
  bench.setTools(() => ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update'])
  bench.setSchedule([
    { id: 'repeat', title: 'Repeat check', prompt: 'Sensitive body', kind: 'every', everySeconds: 300, scheduledAt: '2099-01-01T00:00:00Z' },
    { id: 'late', title: 'Check the build', prompt: 'Check the build', kind: 'after', scheduledAt: '2020-01-01T00:00:00Z' },
    { id: 'tie-a', title: 'First tie', prompt: 'First tie', kind: 'at', scheduledAt: '2020-06-01T00:00:00Z' },
    { id: 'tie-b', title: 'Second tie', prompt: 'Second tie', kind: 'at', scheduledAt: '2020-06-01T00:00:00Z' },
    { id: 'daily', title: 'Daily sweep', prompt: 'Sensitive body', kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai', scheduledAt: '2099-01-01T00:00:00Z' },
  ] as never)
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  const model = bench.model('mayfly.schedule')
  const text = JSON.stringify(model.node)
  expect(text.indexOf('Check the build')).toBeLessThan(text.indexOf('First tie'))
  expect(text.indexOf('First tie')).toBeLessThan(text.indexOf('Second tie'))
  expect(text.indexOf('Second tie')).toBeLessThan(text.indexOf('Repeat check'))
  expect(text).toContain('Overdue')
  expect(text).toContain('Every 5 minutes')
  expect(text).toContain('Daily')
  expect(text).toContain('Asia/Shanghai')
  expect(text).toContain('days overdue')
  expect(text).toContain('original session')
  expect(text).not.toContain('Sensitive body')
  expect(bench.list).toHaveBeenCalledWith({ sessionId: bench.session.id })
  expect(JSON.stringify(bench.ctx.mayflyStatus.list().find(item => item.id === 'mayfly.schedule')?.node)).toContain('Reminders 5')
  for (const width of SCAN_WIDTHS) {
    const renderer = renderRequest(model, { columns: width, rows: 24 })
    expectLinesFit('native-feature', renderer.component.render(width), width)
    renderer.runtime.dispose()
  }
  bench.ctx.mayflyConversations.selectPrimary(bench.other)
  expect(model.disposed).toBe(true)
  await bench.scheduleFiber.dispose()
  expect(bench.ctx.mayflyStatus.list().some(item => item.id === 'mayfly.schedule')).toBe(false)
})
it('formats reminder frequency and relative status across units and locale', async () => {
  const bench = await setup()
  const t = (key: string, values?: Record<string, string | number>) => bench.ctx.mayflyLocale.translate('interaction', key, values)
  const record = (everySeconds: number) => ({ id: 'r', title: 'p', prompt: 'p', kind: 'every', everySeconds, scheduledAt: '2099-01-01T00:00:00Z' }) as never
  expect(schedule.formatReminderFrequency({ id: 'r', title: 'p', prompt: 'p', kind: 'at', scheduledAt: '2099-01-01T00:00:00Z' } as never, t)).toBe('Once')
  expect(schedule.formatReminderFrequency({ id: 'r', title: 'p', prompt: 'p', kind: 'daily', time: '09:00:00', timeZone: 'UTC', scheduledAt: '2099-01-01T00:00:00Z' } as never, t)).toBe('Daily')
  expect(schedule.formatReminderFrequency({ id: 'r', title: 'p', prompt: 'p', kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1], scheduledAt: '2099-01-01T00:00:00Z' } as never, t)).toBe('Weekly')
  expect(schedule.formatReminderFrequency({ id: 'r', title: 'p', prompt: 'p', kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC', scheduledAt: '2099-01-01T00:00:00Z' } as never, t)).toBe('Cron')
  expect(schedule.formatReminderFrequency(record(45), t)).toBe('Every 45 seconds')
  expect(schedule.formatReminderFrequency(record(300), t)).toBe('Every 5 minutes')
  expect(schedule.formatReminderFrequency(record(7200), t)).toBe('Every 2 hours')
  expect(schedule.formatReminderFrequency(record(86400), t)).toBe('Every 1 day')
  expect(schedule.formatReminderFrequency(record(172800), t)).toBe('Every 2 days')
  const now = Date.parse('2030-01-01T00:00:00Z')
  expect(schedule.formatReminderRelative('2030-01-01T00:00:00Z', now, t)).toBe('Due now')
  expect(schedule.formatReminderRelative('2030-01-01T00:05:00Z', now, t)).toBe('in 5 minutes')
  expect(schedule.formatReminderRelative('2030-01-01T00:00:01Z', now, t)).toBe('in 1 second')
  expect(schedule.formatReminderRelative('2030-01-01T00:00:00.500Z', now, t)).toBe('in 1 second')
  expect(schedule.formatReminderRelative('2029-12-31T23:59:59.500Z', now, t)).toBe('1 second overdue')
  expect(schedule.formatReminderRelative('2029-12-31T22:00:00Z', now, t)).toBe('2 hours overdue')
  expect(schedule.formatReminderRelative('2029-12-30T00:00:00Z', now, t)).toBe('2 days overdue')
  expect(typeof schedule.formatReminderLocalTime('2030-01-01T00:00:00Z', 'en')).toBe('string')
  bench.ctx.mayflyLocale.setPreference('zh')
  expect(schedule.formatReminderFrequency(record(300), t)).toBe('每5分钟一次')
  expect(schedule.formatReminderFrequency({ id: 'r', title: 'p', prompt: 'p', kind: 'daily', time: '09:00:00', timeZone: 'UTC', scheduledAt: '2099-01-01T00:00:00Z' } as never, t)).toBe('每天')
  expect(schedule.formatReminderRelative('2030-01-01T00:05:00Z', now, t)).toBe('5分钟后')
  expect(schedule.formatReminderRelative('2029-12-30T00:00:00Z', now, t)).toBe('已逾期 2天')
  bench.ctx.mayflyLocale.setPreference('en')
})
it('refreshes an open reminder catalog on schedule changes and localizes on preference change', async () => {
  const bench = await setup()
  bench.setSchedule([{ id: 'one', title: 'Alpha', prompt: 'Body', kind: 'at', scheduledAt: '2030-01-01T00:00:00Z' }] as never)
  await bench.run('/schedule')
  await flushRequests()
  const model = bench.model('mayfly.schedule')
  bench.setSchedule([{ id: 'two', title: 'Beta', prompt: 'Body', kind: 'at', scheduledAt: '2030-02-01T00:00:00Z' }] as never)
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(model.node)).toContain('Beta')
  bench.setSchedule([])
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(model.node)).toContain('No active reminders')
  expect(bench.ctx.mayflyStatus.list().find(item => item.id === 'mayfly.schedule')?.node ?? null).toBeNull()
  bench.setSchedule([{ id: 'three', title: 'Gamma', prompt: 'Body', kind: 'at', scheduledAt: '2030-03-01T00:00:00Z' }] as never)
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  bench.ctx.mayflyLocale.setPreference('zh')
  expect(JSON.stringify(model.node)).toContain('提醒')
  expect(JSON.stringify(bench.ctx.mayflyStatus.list().find(item => item.id === 'mayfly.schedule')?.node)).toContain('1 个提醒')
  bench.ctx.mayflyLocale.setPreference('en')
})
it('skips the reminder catalog when the invoking Agent is stale or the request is cancelled', async () => {
  const bench = await setup()
  expect(await bench.ctx.commands.execute(bench.other, '/schedule', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
  const definition = bench.ctx.commands.find(bench.agent, 'schedule')!
  const aborted = new AbortController()
  aborted.abort()
  expect(await definition.handler({ agent: bench.agent, signal: aborted.signal, rawInput: '' } as never)).toMatchObject({ kind: 'success' })
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('refreshes reminders only for the selected session and releases its timer', async () => {
  const bench = await setup()
  await bench.run('/schedule')
  await flushRequests()
  const reminders = bench.model('mayfly.schedule')
  expect(await nativeAction(reminders, activate('close'))).toMatchObject({ kind: 'completed' })
  bench.setSchedule([])
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(reminders.node)).toContain('No active reminders')
  expect(bench.list).toHaveBeenCalledWith({ sessionId: bench.session.id })
  await new Promise(resolve => setTimeout(resolve, 1010))
  bench.ctx.mayflyConversations.selectPrimary(null)
  expect(reminders.disposed).toBe(true)
})
it('fences late reminder reads after Agent selection and unload', async () => {
  const bench = await setup()
  const first = Promise.withResolvers<ScheduleRecord[]>()
  const late = [{ id: 'late', title: 'Wrong session', prompt: 'Body', kind: 'at', scheduledAt: '2099-01-01T00:00:00Z' }] as never
  bench.list.mockImplementation(async request => request.sessionId === bench.session.id ? first.promise : [])
  await bench.run('/schedule')
  bench.ctx.mayflyConversations.selectPrimary(bench.other)
  expect(await bench.ctx.commands.execute(bench.other, '/schedule', [], new AbortController().signal)).toMatchObject({ result: { kind: 'success' } })
  await flushRequests()
  first.resolve(late)
  await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.schedule').node)).not.toContain('Wrong session')
  expect(bench.list).toHaveBeenCalledWith({ sessionId: bench.otherSession.id })
  const rejected = Promise.withResolvers<ScheduleRecord[]>()
  bench.list.mockImplementation(async () => rejected.promise)
  bench.ctx.emit('schedule/changed')
  bench.list.mockResolvedValue([])
  bench.ctx.emit('schedule/changed')
  rejected.reject(new Error('stale request'))
  await flushRequests()
  bench.list.mockRejectedValue(new Error('unavailable'))
  bench.ctx.emit('schedule/changed')
  await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.schedule').node)).toContain('Schedule unavailable')
  const pending = Promise.withResolvers<ScheduleRecord[]>()
  bench.list.mockImplementation(async () => pending.promise)
  bench.ctx.emit('schedule/changed')
  await bench.scheduleFiber.dispose()
  pending.resolve(late)
  await flushRequests()
  expect(bench.ctx.mayflyStatus.list().some(item => item.id === 'mayfly.schedule')).toBe(false)
})
