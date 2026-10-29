/**
 * Recorded file deliveries projected by the native session registry. The
 * `deliverables/presented` event is declared by the tool-presenter package,
 * which this Host composition does not type, so its envelope is matched
 * structurally exactly as the facts fold matches the retry records.
 *
 * @module @ephemeral-ai/mayfly-host/conversation/deliverables
 */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const schema = z.array(z.object({ id: z.string(), path: z.string(), description: z.string().optional() }))
type DeliveredFile = z.infer<typeof schema>[number]
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { mayflyDeliverables: DeliveredFile[] }
  interface SessionProjectionMap { mayflyDeliverables: DeliveredFile[] }
}
export const deliverablesProjection = {
  key: 'mayflyDeliverables',
  stateVersion: 1,
  stateSchema: schema,
  init: (): DeliveredFile[] => [],
  apply: (state, event) => (event.type as string) === 'deliverables/presented'
    ? [...state, ...(event as unknown as {
      readonly seq: number
      readonly data: { readonly files: readonly { readonly path: string, readonly description?: string }[] }
    }).data.files.map((file, index) => ({ id: `${String(event.seq)}/${String(index)}`, ...file }))]
    : state,
  wire: { viewSchema: schema, view: state => state },
} satisfies ProjectionDefinition<'mayflyDeliverables', DeliveredFile[]>
