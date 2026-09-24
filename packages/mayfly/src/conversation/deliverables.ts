/** Recorded file deliveries projected by the native session registry.
 * @module @ephemeral-ai/mayfly/conversation/deliverables
 */
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const schema = z.array(z.object({ id: z.string(), path: z.string(), description: z.string().optional() }))
export type DeliveredFile = z.infer<typeof schema>[number]
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { mayflyDeliverables: DeliveredFile[] }
  interface SessionProjectionMap { mayflyDeliverables: DeliveredFile[] }
}
export const deliverablesProjection = {
  key: 'mayflyDeliverables',
  stateVersion: 1,
  stateSchema: schema,
  init: (): DeliveredFile[] => [],
  apply: (state, event) => event.type === 'deliverables/presented'
    ? [...state, ...event.data.files.map((file, index) => ({ id: `${event.seq}/${index}`, ...file }))]
    : state,
  wire: { viewSchema: schema, view: state => state },
} satisfies ProjectionDefinition<'mayflyDeliverables', DeliveredFile[]>
