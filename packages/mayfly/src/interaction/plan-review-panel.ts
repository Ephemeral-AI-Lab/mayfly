/** Plan review declarations and native outcomes, without terminal or draft state.
 * @module @ephemeral-ai/mayfly/interaction/plan-review-panel
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'

export interface PlanReviewChoices {
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

export function planReviewView(question: AskUserQuestionItem, choices: PlanReviewChoices, t: MayflyTranslate): MayflyUiNode {
  const feedback = [{ controlId: 'review', itemId: 'feedback' }]
  return ui.stack.column([
    ui.text(question.question),
    ui.child(ui.scroll(ui.markdown(question.detail ?? ''), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ui.tabs({ id: 'review', activeId: 'decision', items: [{ id: 'decision', label: t('Plan review') }, { id: 'feedback', label: t('Revise'), backId: 'decision' }] }),
    ui.child(ui.actions({ id: 'decisions', items: [
      { id: 'reject', label: t('Reject'), defaultFocus: true },
      { id: 'approve', label: choices.approve.label },
      { id: 'revise', label: t('Revise'), navigate: feedback },
    ] }), { tab: { controlId: 'review', itemId: 'decision' } }),
    ui.child(ui.stack.column([
      ui.form({ id: 'revision', fields: [{ kind: 'textarea', id: 'reason', label: t('Revise'), value: '' }] }),
      ui.actions({ id: 'feedback-actions', items: [
        { id: 'send-feedback', label: t('Submit feedback'), submit: [{ pagePath: feedback, formId: 'revision' }] },
        { id: 'back', label: t('Back'), navigate: [{ controlId: 'review', itemId: 'decision' }] },
      ] }),
    ]), { tab: feedback[0]! }),
  ])
}

export function planReviewAnswer(question: AskUserQuestionItem, choices: PlanReviewChoices, event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind === 'activate' && (event.actionId === 'approve' || event.actionId === 'reject')) return { answers: [{ id: question.id, selected: [event.actionId === 'approve' ? choices.approve.label : choices.decline.label] }] }
  if (event.kind !== 'submit' || event.submission.actionId !== 'send-feedback') return undefined
  const reason = event.submission.forms[0]?.fields.find(field => field.id === 'reason')?.value
  return { answers: [{ id: question.id, selected: typeof reason === 'string' && reason.length > 0 ? [] : [choices.decline.label], ...typeof reason === 'string' && reason.length > 0 ? { custom: reason } : {} }] }
}
