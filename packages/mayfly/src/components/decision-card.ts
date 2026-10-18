/**
 * The decision card: the one composition every "the agent asks, you decide" moment shares (a tool approval, a plan review).
 * It is a lane at the foot of the stream, where the editor normally sits: a rule carrying the title (and how many
 * requests wait), the choices numbered so a digit chooses at once, the common grant first and the refusal last, a note
 * field under them, and hidden keys that open the request in `$EDITOR` or copy it. `Esc` rejects, and the hint row says so.
 * A choice and the note settle as one action: the note travels only with a rejection (an approval's refusal) or a plan's
 * revision, and an allow, an approve, or a plan's Reject drops it. The card carries no
 * level, no width, and no timer: the overlay it rides on holds the arm delay that keeps a stray key from granting.
 *
 * @module components/decision-card
 */

import { decisionLane, type MayflyActionItem, type MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'

/** The ids the card's controls carry, which the plugin that settles the request reads back from the events. */
export const DECISION = {
  /** The choice list. */
  options: 'decision.options',
  /** The note field's form. */
  note: 'decision.note',
  /** The note field's id inside its form. */
  field: 'note',
  /** The hidden action a choice runs (Enter, or its digit). */
  choose: 'decide',
  /** The hidden action Enter in the note field runs. */
  send: 'send-note',
  /** The hidden keys' actions node. */
  keys: 'decision.keys',
} as const

/** A hidden key of the card: it runs from anywhere on the card, with the hint the row shows for it. */
export interface DecisionCardKey {
  readonly id: string
  readonly semantic: 'copy' | 'external'
  readonly label: string
  readonly hintLabel: string
}

/** The facts of one card. Every text is final: translated and sanitized. */
export interface DecisionCardFacts {
  /** The rule's title. */
  readonly title: string
  /** How many requests wait, when more than one (`1 of 3 waiting`). */
  readonly queue?: string
  /** The choices in order: the common grant first, the refusal last. A digit chooses the row at its position. */
  readonly options: readonly { readonly id: string, readonly label: string }[]
  /** The note field under the choices: `Feedback:` on an approval, `Revise:` on a plan. */
  readonly note: { readonly label: string, readonly placeholder: string }
  readonly keys: readonly DecisionCardKey[]
}

/**
 * The card as a surface node.
 * @param facts - the title, the choices, the note, and the hidden keys.
 * @returns a lane surface for the editor slot.
 */
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
