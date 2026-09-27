/** Native reminder catalog and session-local delivery indicator.
 * @module @ephemeral-ai/mayfly/interaction/schedule-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openUiOverlay } from './ui-overlay.ts'

export const name = 'mayfly-schedule-command'
export const inject = ['commands', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyStatus']

export function scheduleNode(records: readonly ScheduleRecord[] | undefined, now = Date.now()): MayflyUiNode {
  return ui.surface({ title: 'Reminders', chrome: 'overlay', child: ui.stack.column([
    ui.text('Reminders follow their original session, even when no Agent is running. Create or cancel reminders through the conversation. Enable Schedule in profile files.'),
    ...(records === undefined ? [ui.empty({ title: 'Schedule unavailable' })] : [ui.list({ id: 'reminders', role: 'browse', filterable: true, selectedIds: [], items: records.map(record => ({
      id: record.id, label: record.title, badge: Date.parse(record.scheduledAt) <= now ? 'overdue' : 'scheduled',
      detail: `${record.scheduledAt} · ${record.kind === 'every' ? `every ${record.everySeconds}s` : record.kind === 'after' || record.kind === 'at' ? 'one-time' : record.kind} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    })), empty: ui.empty({ title: 'No active reminders' }) })]),
    ui.actions({ id: 'reminder-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
}

export function apply(ctx: Context): void {
  let handle: MayflyOverlayHandle | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let records: readonly ScheduleRecord[] | undefined
  const status = ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
  const render = () => {
    status.set(records?.length ? ui.text(`Reminders ${records.length}`) : null)
    if (handle?.closed === false) handle.set(scheduleNode(records))
  }
  const refresh = async () => {
    const agent = ctx.mayflyCurrentAgent.current()
    const currentGeneration = ++generation
    const service = ctx.get('schedule')
    if (agent === null || service === undefined) {
      records = undefined
      render()
      return
    }
    try {
      const next = await service.list({ sessionId: agent.session.id })
      if (generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = next
    } catch {
      if (generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = undefined
    }
    render()
  }
  ctx.commands.register({ name: 'schedule', description: 'Inspect session-local reminders', handler: () => {
    handle = openUiOverlay(ctx, { id: 'mayfly.schedule', title: 'Reminders', presentation: 'editor', capturing: true, onEvent: { action: () => ({ kind: 'completed' }) } }, scheduleNode(records), { reopen: 'replace', onClosed: () => {
      clearInterval(timer)
      timer = undefined
    } })
    void refresh()
    timer = setInterval(render, 1000)
    timer.unref()
    return { kind: 'success' }
  } })
  ctx.effect(() => ctx.mayflyCurrentAgent.subscribe(() => {
    handle?.close()
    records = undefined
    render()
    void refresh()
  }))
  ctx.on('schedule/changed', () => { void refresh() })
  ctx.effect(() => () => {
    generation++
    clearInterval(timer)
    status.dispose()
  })
}
