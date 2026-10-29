/**
 * Shared Remote decision-card presentation for approvals and plan reviews.
 * @module @ephemeral-ai/mayfly/remote/interactions/decision-card
 */

import { decisionLane, type MayflyActionItem, type MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'

export const DECISION = {
  options: 'decision.options',
  note: 'decision.note',
  field: 'note',
  choose: 'decide',
  send: 'send-note',
  keys: 'decision.keys',
} as const

export interface DecisionCardKey {
  readonly id: string
  readonly semantic: 'copy' | 'external'
  readonly label: string
  readonly hintLabel: string
}

export interface DecisionCardFacts {
  readonly title: string
  readonly queue?: string
  readonly options: readonly { readonly id: string, readonly label: string }[]
  readonly note: { readonly label: string, readonly placeholder: string }
  readonly keys: readonly DecisionCardKey[]
}

/** Build the current Mayfly decision lane from final, localized facts. */
export function DecisionCard(facts: DecisionCardFacts): MayflySurfaceNode {
  return decisionLane({
    id: 'decision',
    title: facts.title,
    escapeLabel: 'reject',
    ...(facts.queue === undefined ? {} : { badges: [{ text: facts.queue, tone: 'warning' }] }),
    choices: facts.options.map(option => ({ id: option.id, label: option.label })),
    note: { id: DECISION.field, label: facts.note.label, placeholder: facts.note.placeholder },
    acceptActionId: DECISION.choose,
    sendActionId: DECISION.send,
    keys: [
      ...facts.keys.map((key): MayflyActionItem => ({ id: key.id, label: key.label, hidden: true, semantic: key.semantic, hintLabel: key.hintLabel })),
    ],
  })
}
