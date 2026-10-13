/** Plan review declarations and native outcomes, without terminal or draft state.
 * @module @ephemeral-ai/mayfly/interaction/plan-review-panel
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import type { MayflyUiActionEvent, MayflyUiActionReply, MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'
import { DECISION, DecisionCard } from '../components/decision-card.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { copyDocument, readDecision } from './decision-actions.ts'

interface PlanReviewChoices {
  readonly approve: AskUserQuestionOption
  readonly decline: AskUserQuestionOption
}

export function planReviewChoices(question: AskUserQuestionItem): PlanReviewChoices | undefined {
  if (question.intent?.kind !== 'plan-review') return undefined
  const options = question.options ?? []
  if (options.length !== 2) return undefined
  const approve = options.find(option => option.label === question.intent!.approve)
  if (approve === undefined) return undefined
  return { approve, decline: options[options[0] === approve ? 1 : 0]! }
}

/**
 * The plan's decision card. The plan itself is the stream's request block; the card holds the choices and the revision
 * note. The wording is fixed, and the answer maps each row to the question's own labels.
 */
export function planReviewCard(t: MayflyTranslate): MayflySurfaceNode {
  return DecisionCard({
    title: t('Decide'),
    options: [
      { id: 'approve', label: t('Approve and start') },
      { id: 'keep', label: t('Keep planning…') },
      { id: 'reject', label: t('Reject') },
    ],
    note: { label: t('Revise'), placeholder: t('type the revision in place') },
    keys: [
      { id: 'copy', semantic: 'copy', label: t('Copy plan'), hintLabel: t('copy plan') },
      { id: 'open', semantic: 'external', label: t('Open plan'), hintLabel: t('open plan') },
    ],
  })
}

/**
 * The native answer a card event settles: the approve label, the decline label (`Reject`: a note typed beside it is not
 * sent, so only a revision tells a plan sent back from a rejected one), or the revision text itself for `Keep planning…`.
 * A `Keep planning…` with nothing typed settles nothing.
 */
export function planReviewAnswer(question: AskUserQuestionItem, choices: PlanReviewChoices, event: MayflyUiActionEvent): AskUserQuestionAnswer | undefined {
  const read = readDecision(event)
  if (read === undefined) return undefined
  if (read.action === 'send' || read.choice === 'keep') return read.note === '' ? undefined : { answers: [{ id: question.id, selected: [], custom: read.note }] }
  if (read.choice === 'approve') return { answers: [{ id: question.id, selected: [choices.approve.label] }] }
  return { answers: [{ id: question.id, selected: [choices.decline.label] }] }
}

/** Non-settling keys: copying writes the plan markdown to the clipboard, and `Keep planning…` with nothing typed asks for the revision. */
export async function planReviewAction(question: AskUserQuestionItem, event: MayflyUiActionEvent, t: MayflyTranslate): Promise<MayflyUiActionReply | undefined> {
  if (event.kind === 'activate' && event.actionId === 'copy') return copyDocument(question.detail ?? '', t('Plan copied to clipboard'), t('Plan copy failed'))
  const read = readDecision(event)
  if (read !== undefined && read.note === '' && (read.action === 'send' || read.choice === 'keep')) {
    return { kind: 'invalid', errors: [{ pagePath: [], formId: DECISION.note, fieldId: DECISION.field, message: t('Write what to change first') }] }
  }
  return undefined
}
