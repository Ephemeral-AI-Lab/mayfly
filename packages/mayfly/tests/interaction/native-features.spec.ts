/** Native reminder projections follow the selected Agent without owning delivery.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-features
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import * as schedule from '../../src/interaction/schedule-command.ts'
import { informationFixture } from './information-fixture.ts'
import { nativeAction, activate } from './native-action-fixture.ts'
import { renderRequest } from './request-fixture.ts'
import { SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const changed: ((session: unknown, key: string) => void)[] = []
  vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation(callback => { changed.push(callback as never); return () => {} })
  let schedules: readonly ScheduleRecord[] | undefined
  vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => ({ asOfSeq: 0, values: { schedule: schedules } }) as never)
  const scheduleFiber = await ctx.plugin(schedule)
  return { ...bench, changed, scheduleFiber, setSchedule: (value: readonly ScheduleRecord[] | undefined) => { schedules = value } }
}
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

it('refreshes reminders only for the selected session and releases its timer', async () => {
  const bench = await setup()
  await bench.run('/schedule')
  const reminders = bench.model('mayfly.schedule')
  expect(await nativeAction(reminders, activate('close'))).toMatchObject({ kind: 'completed' })
  bench.setSchedule([])
  for (const callback of bench.changed) { callback(bench.session, 'schedule'); callback(bench.otherSession, 'schedule'); callback(bench.session, 'other') }
  expect(JSON.stringify(reminders.node)).toContain('No active reminders')
  await new Promise(resolve => setTimeout(resolve, 1010))
  bench.ctx.mayflyCurrentAgent.select(null)
  expect(reminders.disposed).toBe(true)
})
