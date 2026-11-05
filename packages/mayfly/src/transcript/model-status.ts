/** Shared status-basic-model presentation over readonly facts. @module */
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { SHED, shedNode } from './status-shed.ts'
/** The displayed triple: the provider, the model, and the source-paired effort id. */
interface StatusModelSelection {
  readonly provider?: string
  readonly model: string
  readonly effort?: string
}

/** Capitalize the effort id's head: `max` → `Max`, `x-high` → `X-high`. */
function capitalizeEffort(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** Build the published model row and its narrower forms from one paired selection. */
export function buildModelStatusNode(selection: StatusModelSelection | undefined): MayflyStatusNode | null {
  const model = selection?.model ?? ''
  if (model === '') return null
  const provider = selection?.provider ?? ''
  const effort = selection?.effort === undefined ? '' : capitalizeEffort(selection.effort)
  const text = `${provider === '' ? model : `${provider}/${model}`}${effort === '' ? '' : ` ${effort}`}`
  const plain = (content: string): MayflyStatusNode => ({ kind: 'text', content, tone: 'default' })
  const withEffort = effort === '' ? model : `${model} ${effort}`
  return shedNode(plain(text), [
    ...provider === '' ? [] : [{ rank: SHED.provider, node: plain(withEffort) }],
    ...effort === '' ? [] : [{ rank: SHED.effort, node: plain(model) }],
    { rank: SHED.model, node: null },
  ])
}
