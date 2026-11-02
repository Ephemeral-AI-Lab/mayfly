/** Native readonly reminder DTO aliases and the common rc.2 presentation. @module */
import type { HostClient } from '../../client/types.ts'
/** Official selected-Session reminder record. */
export type RemoteScheduleRecord = Extract<Awaited<ReturnType<HostClient['remote']['schedule']['list']>>, { readonly ok: true }>['value'][number]
export { scheduleNode as remoteScheduleNode, formatReminderFrequency as formatRemoteReminderFrequency, formatReminderRelative as formatRemoteReminderRelative } from '@ephemeral-ai/mayfly/command-panels'
