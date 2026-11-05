/**
 * Remote plan-review choices, answers, and validation without Host-bound actions.
 * @module @ephemeral-ai/mayfly/remote/interactions/plan-review-panel
 */

import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'
import type { QuestionAnswer, QuestionRequest } from './official.ts'
import { DECISION, DecisionCard } from './decision-card.ts'
import { readDecision } from './decision-actions.ts'

type Question = QuestionRequest['questions'][number]
type QuestionOption = NonNullable<Question['options']>[number]

export interface PlanReviewChoices {
  readonly approve: QuestionOption
  readonly decline: QuestionOption
}

export function planReviewChoices(question: Question): PlanReviewChoices | undefined {
  if (question.intent?.kind !== 'plan-review') return undefined
  const options = question.options ?? []
  if (options.length !== 2) return undefined
  const approve = options.find(option => option.label === question.intent!.approve)
  if (approve === undefined) return undefined
  return { approve, decline: options[options[0] === approve ? 1 : 0]! }
}

export function planReviewCard(t: MayflyTranslate): MayflySurfaceNode {
  return DecisionCard({
    title: t('Decide'),
    options: [
      { id: 'approve', label: t('Approve and start') },
      { id: 'keep', label: t('Keep planning…') },
      { id: 'reject', label: t('Reject') },
    ],
    note: { label: t('Revise'), placeholder: t('type the revision in place') },
    keys: [],
  })
}

export function planReviewAnswer(question: Question, choices: PlanReviewChoices, event: MayflyUiActionEvent): QuestionAnswer | undefined {
  const read = readDecision(event)
  if (read === undefined) return undefined
  if (read.action === 'send' || read.choice === 'keep') return read.note === '' ? undefined : { answers: [{ id: question.id, selected: [], custom: read.note }] }
  if (read.choice === 'approve') return { answers: [{ id: question.id, selected: [choices.approve.label] }] }
  if (read.choice === 'reject') return { answers: [{ id: question.id, selected: [choices.decline.label] }] }
  return undefined
}

/** Keep the shared revision-required validation; clipboard and external-editor actions belong to their own lane. */
export async function planReviewAction(event: MayflyUiActionEvent, t: MayflyTranslate): Promise<MayflyUiActionReply | undefined> {
  const read = readDecision(event)
  if (read !== undefined && read.note === '' && (read.action === 'send' || read.choice === 'keep')) {
    return { kind: 'invalid', errors: [{ pagePath: [], formId: DECISION.note, fieldId: DECISION.field, message: t('Write what to change first') }] }
  }
  return undefined
}
