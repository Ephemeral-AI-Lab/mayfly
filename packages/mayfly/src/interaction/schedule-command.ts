/** Native reminder catalog and session-local delivery indicator.
 * @module @ephemeral-ai/mayfly/interaction/schedule-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openUiOverlay } from './ui-overlay.ts'

export const name = 'mayfly-schedule-command'
export const inject = ['commands', 'sessionProjections', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyStatus']

export function scheduleNode(records: readonly ScheduleRecord[] | undefined, now = Date.now()): MayflyUiNode {
  return ui.surface({ title: 'Reminders', chrome: 'overlay', child: ui.stack.column([
    ui.text('Delivery requires a live root session. Create or cancel reminders through the conversation. Enable Schedule in files before starting or resuming the session.'),
    ...(records === undefined ? [ui.empty({ title: 'Schedule unavailable' })] : [ui.list({ id: 'reminders', role: 'browse', filterable: true, selectedIds: [], items: records.map(record => ({
      id: record.id, label: record.prompt, badge: Date.parse(record.scheduledAt) <= now ? 'overdue' : 'scheduled',
      detail: `${record.scheduledAt} · ${'everySeconds' in record ? `every ${record.everySeconds}s` : 'one-time'} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    })), empty: ui.empty({ title: 'No active reminders' }) })]),
    ui.actions({ id: 'reminder-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
}

export function apply(ctx: Context): void {
  let handle: MayflyOverlayHandle | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const status = ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
  const records = () => {
    const agent = ctx.mayflyCurrentAgent.current()
    return agent === null ? undefined : ctx.sessionProjections.snapshot(agent.session, ['schedule']).values.schedule
  }
  const refresh = () => {
    const value = records()
    status.set(value?.length ? ui.text(`Reminders ${value.length}`) : null)
    if (handle?.closed === false) handle.set(scheduleNode(value))
  }
  ctx.commands.register({ name: 'schedule', description: 'Inspect session-local reminders', handler: () => {
    handle = openUiOverlay(ctx, { id: 'mayfly.schedule', title: 'Reminders', presentation: 'editor', capturing: true, onEvent: { action: () => ({ kind: 'completed' }) } }, scheduleNode(records()), { reopen: 'replace', onClosed: () => {
      clearInterval(timer)
      timer = undefined
    } })
    timer = setInterval(refresh, 1000)
    timer.unref()
    return { kind: 'success' }
  } })
  ctx.effect(() => ctx.mayflyCurrentAgent.subscribe(() => {
    handle?.close()
    refresh()
  }))
  ctx.effect(() => ctx.sessionProjections.onChanged((session, key) => { if (session === ctx.mayflyCurrentAgent.current()?.session && key === 'schedule') refresh() }))
  ctx.effect(() => () => {
    clearInterval(timer)
    status.dispose()
  })
}
