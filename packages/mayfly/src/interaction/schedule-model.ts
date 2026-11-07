/** Readonly rc.2 reminder presentation shared by native and Remote owners.
 * @module @ephemeral-ai/mayfly/interaction/schedule-model
 */
import { panel, ui, type MayflyListItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyLocaleId, MayflyTranslate } from '../frontend/locale.ts'

/** Renderer-neutral timing facts supplied by the native or independent owner. */
type ScheduleRecord = { readonly id: string, readonly title: string, readonly scheduledAt: string } & (
  | { readonly kind: 'every', readonly everySeconds: number }
  | { readonly kind: 'daily' | 'weekly' | 'cron', readonly timeZone: string }
  | { readonly kind: 'after' | 'at' | 'rrule' }
)

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
function formatReminderFrequency(record: ScheduleRecord, t: MayflyTranslate): string {
  if (record.kind === 'daily') return t('Daily')
  if (record.kind === 'weekly') return t('Weekly')
  if (record.kind === 'cron') return t('Cron')
  if (record.kind === 'rrule') return 'RRULE'
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
function formatReminderLocalTime(scheduledAt: string, locale?: MayflyLocaleId): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(Date.parse(scheduledAt))
}

/** Human relative target using the largest natural clock unit. */
function formatReminderRelative(scheduledAt: string, now: number, t: MayflyTranslate): string {
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
function orderScheduleRecords(
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
  return panel({ title: t('Reminders'), escapeLabel: 'back', body: ui.stack.column([
    ui.text(t('Reminders follow their original session, even when no Agent is running. Create or cancel reminders through the conversation.')),
    ...(records === undefined ? [ui.empty({ title: t('Schedule unavailable'), description: t('The Schedule capability is a Host service; enable it in profile files.') })] : [ui.list({ id: 'reminders', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items, empty: ui.empty({ title: t('No active reminders') }) })]),
  ]) })
}

