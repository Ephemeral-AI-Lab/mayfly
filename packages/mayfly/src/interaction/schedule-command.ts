/** Native Host-wide reminder catalog view over the Schedule service.
 * @module @ephemeral-ai/mayfly/interaction/schedule-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyLocaleId, MayflyTranslate } from '../frontend/index.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-schedule-command'
export const inject = ['commands', 'mayflyCurrentAgent', 'mayflyOverlays', 'mayflyStatus', 'tools']

type TimeUnit = 'day' | 'hour' | 'minute' | 'second'

const SECOND_MS = 1_000
const SECOND_UNIT = { unit: 'second', seconds: 1 } as const
const UNIT_SECONDS: readonly { unit: TimeUnit; seconds: number }[] = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
  SECOND_UNIT,
]

/** Localized unit word for one integral magnitude. */
function unitLabel(unit: TimeUnit, value: number, t: MayflyTranslate): string {
  const keys = {
    day: ['day', 'days'],
    hour: ['hour', 'hours'],
    minute: ['minute', 'minutes'],
    second: ['second', 'seconds'],
  } as const
  const pair = keys[unit]
  return t(value === 1 ? pair[0] : pair[1])
}

/** Pick the largest exact whole unit without rounding the durable interval. */
export function formatReminderFrequency(record: ScheduleRecord, t: MayflyTranslate): string {
  if (record.kind === 'daily') return t('Daily')
  if (record.kind === 'weekly') return t('Weekly')
  if (record.kind === 'cron') return t('Cron')
  if (record.kind !== 'every') return t('Once')
  let selected: { unit: TimeUnit; seconds: number } = SECOND_UNIT
  for (const candidate of UNIT_SECONDS) {
    if (record.everySeconds % candidate.seconds !== 0) continue
    selected = candidate
    break
  }
  const value = record.everySeconds / selected.seconds
  return t('Every {value} {unit}', { value, unit: unitLabel(selected.unit, value, t) })
}

/** Format the durable UTC target in the frontend's current locale and process zone. */
export function formatReminderLocalTime(scheduledAt: string, locale?: MayflyLocaleId): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(Date.parse(scheduledAt))
}

/** Human relative target using the largest natural clock unit. */
export function formatReminderRelative(scheduledAt: string, now: number, t: MayflyTranslate): string {
  const difference = Date.parse(scheduledAt) - now
  if (difference === 0) return t('Due now')
  const absoluteSeconds = Math.abs(difference) / SECOND_MS
  const selected = UNIT_SECONDS.find(candidate => absoluteSeconds >= candidate.seconds)
    ?? SECOND_UNIT
  const value = Math.max(1, difference > 0
    ? Math.ceil(absoluteSeconds / selected.seconds)
    : Math.floor(absoluteSeconds / selected.seconds))
  const unit = unitLabel(selected.unit, value, t)
  return t(difference > 0 ? 'in {value} {unit}' : '{value} {unit} overdue', { value, unit })
}

/** Overdue records first, then ascending target time; exact ties stay stable. */
export function orderScheduleRecords(
  records: readonly ScheduleRecord[],
  now: number,
): ScheduleRecord[] {
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftTime = Date.parse(left.record.scheduledAt)
    const rightTime = Date.parse(right.record.scheduledAt)
    const leftOverdue = leftTime <= now
    const rightOverdue = rightTime <= now
    if (leftOverdue !== rightOverdue) return Number(rightOverdue) - Number(leftOverdue)
    return leftTime - rightTime || left.index - right.index
  }).map(({ record }) => record)
}

export function scheduleNode(records: readonly ScheduleRecord[] | undefined, now: number, t: MayflyTranslate, locale?: MayflyLocaleId): MayflyUiNode {
  const items: readonly MayflyListItem[] = records === undefined ? [] : orderScheduleRecords(records, now).map(record => ({
    id: record.id,
    label: record.title,
    badge: Date.parse(record.scheduledAt) <= now ? t('Overdue') : t('Scheduled'),
    detail: `${formatReminderFrequency(record, t)}${'timeZone' in record ? ` · ${record.timeZone}` : ''} · ${formatReminderLocalTime(record.scheduledAt, locale)} · ${formatReminderRelative(record.scheduledAt, now, t)}`,
  }))
  return ui.surface({ title: t('Reminders'), chrome: 'overlay', child: ui.stack.column([
    ui.text(t('Reminders follow their original session, even when no Agent is running. Create or cancel reminders through the conversation.')),
    ...(records === undefined ? [ui.empty({ title: t('Schedule unavailable'), description: t('The Schedule capability is a Host service; enable it in profile files.') })] : [ui.list({ id: 'reminders', role: 'browse', filterable: true, selectedIds: [], items, empty: ui.empty({ title: t('No active reminders') }) })]),
    ui.actions({ id: 'reminder-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const t = interactionTranslator(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const status = ctx.mayflyStatus.register({ id: 'mayfly.schedule', priority: 2, overflow: 'hide' }, null)
  let generation = 0
  let records: readonly ScheduleRecord[] | undefined
  const listeners = new Set<() => void>()
  const render = () => {
    status.set(records?.length ? ui.text(t('Reminders {count}', { count: records.length })) : null)
    for (const listener of listeners) listener()
  }
  // Capability is an exact-Agent question: the Host Schedule service attaches
  // reminder tools to every root Agent it observes, so the Agent's visible
  // toolset answers both whether the service is mounted and whether this
  // Agent's scope carries the tools.
  const capable = (agent: Agent): boolean => {
    try {
      return ctx.tools.schemas(agent).some(schema => schema.name === 'schedule_create')
    } catch {
      return false
    }
  }
  const refresh = async (agent: Agent): Promise<void> => {
    const service = ctx.get('schedule')
    const currentGeneration = ++generation
    if (service === undefined || !capable(agent)) {
      records = undefined
      render()
      return
    }
    try {
      const next = await service.list({ sessionId: agent.session.id })
      if (lifetime.signal.aborted || generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = next
    } catch {
      if (lifetime.signal.aborted || generation !== currentGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
      records = undefined
    }
    render()
  }
  const refreshCurrent = () => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) {
      generation++
      records = undefined
      render()
      return
    }
    void refresh(agent)
  }
  ctx.commands.register({ name: 'schedule', description: t('Inspect session reminders'), handler: async invocation => {
    const agent = invocation.agent
    const signal = AbortSignal.any([lifetime.signal, invocation.signal])
    if (signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'success' }
    const node = () => scheduleNode(records, Date.now(), t, ctx.get('mayflyLocale')?.snapshot.locale)
    let handle: MayflyOverlayHandle | undefined
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.schedule', presentation: 'editor', capturing: true }, node(), owner => {
      const update = () => { if (handle?.closed === false) handle.set(node()) }
      listeners.add(update)
      owner.effect(() => ctx.on('schedule/changed', refreshCurrent))
      owner.effect(() => observeInteractionLocale(owner, update))
      const timer = setInterval(update, 1000)
      timer.unref()
      owner.effect(() => () => { listeners.delete(update); clearInterval(timer) })
      refreshCurrent()
      return () => ({ kind: 'completed' })
    }, { signal, reopen: 'focus' })
    return { kind: 'success' }
  } })
  ctx.effect(() => ctx.mayflyCurrentAgent.subscribe(() => refreshCurrent()))
  ctx.effect(() => ctx.on('schedule/changed', refreshCurrent))
  ctx.effect(() => observeInteractionLocale(ctx, () => render()))
  refreshCurrent()
  ctx.effect(() => () => status.dispose())
}
