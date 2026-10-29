/**
 * Current Mayfly reminder rows and relative-time formatting for Remote catalogs.
 * @module @ephemeral-ai/mayfly/remote/panels/schedule
 */

import type { HostClient } from '../../client/types.ts'
import { panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Official selected-Session reminder record. */
export type RemoteScheduleRecord = Extract<Awaited<ReturnType<HostClient['remote']['schedule']['list']>>, { readonly ok: true }>['value'][number]
/** Official Host-wide reminder catalog entry. */
export type RemoteScheduleCatalogEntry = Extract<Awaited<ReturnType<HostClient['remote']['schedule']['catalog']>>, { readonly ok: true }>['value'][number]

type TimeUnit = 'day' | 'hour' | 'minute' | 'second'
const UNITS: readonly { readonly unit: TimeUnit, seconds: number }[] = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
]

function unitLabel(unit: TimeUnit, value: number, t: MayflyTranslate): string {
  const keys = { day: ['day', 'days'], hour: ['hour', 'hours'], minute: ['minute', 'minutes'], second: ['second', 'seconds'] } as const
  const pair = keys[unit]
  return t(value === 1 ? pair[0] : pair[1])
}

/** Format a reminder's durable recurrence without rounding its stored interval. */
export function formatRemoteReminderFrequency(record: RemoteScheduleRecord, t: MayflyTranslate): string {
  if (record.kind === 'daily') return t('Daily')
  if (record.kind === 'weekly') return t('Weekly')
  if (record.kind === 'cron') return t('Cron')
  if (record.kind !== 'every') return t('Once')
  const selected = UNITS.find(candidate => record.everySeconds % candidate.seconds === 0) ?? UNITS.at(-1)!
  const value = record.everySeconds / selected.seconds
  return t('Every {value} {unit}', { value, unit: unitLabel(selected.unit, value, t) })
}

/** Format a reminder target relative to the current wall clock. */
export function formatRemoteReminderRelative(scheduledAt: string, now: number, t: MayflyTranslate): string {
  const difference = Date.parse(scheduledAt) - now
  if (difference === 0) return t('Due now')
  const absoluteSeconds = Math.abs(difference) / 1_000
  const selected = UNITS.find(candidate => absoluteSeconds >= candidate.seconds) ?? UNITS.at(-1)!
  const value = Math.max(1, difference > 0
    ? Math.ceil(absoluteSeconds / selected.seconds)
    : Math.floor(absoluteSeconds / selected.seconds))
  const unit = unitLabel(selected.unit, value, t)
  return t(difference > 0 ? 'in {value} {unit}' : '{value} {unit} overdue', { value, unit })
}

function ordered<Row extends RemoteScheduleRecord>(records: readonly Row[], now: number): Row[] {
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftTime = Date.parse(left.record.scheduledAt)
    const rightTime = Date.parse(right.record.scheduledAt)
    const overdue = Number(rightTime <= now) - Number(leftTime <= now)
    return overdue || leftTime - rightTime || left.index - right.index
  }).map(({ record }) => record)
}

/** Build the current Mayfly reminder panel for selected or Host-wide records. */
export function remoteScheduleNode<Row extends RemoteScheduleRecord>(
  records: readonly Row[] | undefined,
  now: number,
  t: MayflyTranslate,
  locale: string | undefined,
  options: { readonly title?: string, readonly catalog?: boolean, readonly error?: string } = {},
): MayflyUiNode {
  const items: readonly MayflyListItem[] = records === undefined ? [] : ordered(records, now).map(record => ({
    id: String(record.id),
    label: record.title,
    badge: 'status' in record && record.status === 'inactive' ? t('Inactive') : Date.parse(record.scheduledAt) <= now ? t('Overdue') : t('Scheduled'),
    detail: [
      formatRemoteReminderFrequency(record, t),
      ...'timeZone' in record && typeof record.timeZone === 'string' ? [record.timeZone] : [],
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(Date.parse(record.scheduledAt)),
      formatRemoteReminderRelative(record.scheduledAt, now, t),
      ...options.catalog === true && 'sessionId' in record ? [`${t('Session')}: ${String(record.sessionId)}`] : [],
      ...'status' in record && (record.status === 'active' || record.status === 'inactive') ? [t(record.status)] : [],
    ].join(' · '),
  }))
  return panel({
    title: t(options.title ?? 'Reminders'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ui.text(t('Reminders follow their original session, even when no Agent is running. Create or cancel reminders through the conversation.')),
      ...options.error === undefined ? [] : [ui.text(options.error, { tone: 'danger', overflow: 'wrap' })],
      ...records === undefined
        ? [ui.empty({ title: t('Schedule unavailable'), description: t('Enable the Schedule service on the Host, then refresh.') })]
        : [ui.list({ id: 'reminders', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items, empty: ui.empty({ title: t('No active reminders') }) })],
      ui.actions({ id: 'schedule-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
