/** Native readonly reminder DTO aliases and the common rc.2 presentation. @module */
import type { HostClient } from '../../client/types.ts'
/** Official selected-Session reminder record. */
export type RemoteScheduleRecord = Extract<Awaited<ReturnType<HostClient['remote']['schedule']['catalog']>>, { readonly ok: true }>['value'][number]
export { scheduleNode as remoteScheduleNode } from '../../interaction/schedule-model.ts'
