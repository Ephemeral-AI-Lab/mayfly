/**
 * Read choice and note values from Remote decision-card actions.
 * @module @ephemeral-ai/mayfly/app/interactions/decision-actions
 */

import type { MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { DECISION } from '../../components/decision-card.ts'

interface DecisionRead {
  readonly action: 'choose' | 'send'
  readonly choice?: string
  readonly note: string
}

/** Decode only the card's choose and send-note actions; all other events leave the request open. */
export function readDecision(event: MayflyUiActionEvent): DecisionRead | undefined {
  if (event.kind !== 'activate' || event.inputs === undefined) return undefined
  if (event.actionId !== DECISION.choose && event.actionId !== DECISION.send) return undefined
  const value = event.inputs.forms[0]?.fields.find(field => field.id === DECISION.field)?.value
  const note = typeof value === 'string' ? value.trim() : ''
  if (event.actionId === DECISION.send) return { action: 'send', note }
  const choice = event.inputs.selections?.find(selection => selection.controlId === DECISION.options)?.selectedIds[0]
  return choice === undefined ? undefined : { action: 'choose', choice, note }
}
