/** Plan review declarations and native outcomes, without terminal or draft state.
 * @module @ephemeral-ai/mayfly/interaction/plan-review-panel
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { ui, type MayflyUiActionReply, type MayflyUiEvent, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { copyTextToClipboard } from './clipboard-write.ts'

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

/* The hint is a persistent row, not a context hint: the hint line admits only
   its top three entries and the plan's own keyed actions already fill them. */
const scrollHint = (t: MayflyTranslate): MayflyUiNode => ui.text(t('PgUp/PgDn · ⇧↑↓ scroll plan'), { tone: 'muted' })

/** Decision-page controls only; the plan body lives in the content flow. */
export function planReviewControls(question: AskUserQuestionItem, choices: PlanReviewChoices, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.text(question.question),
    /* Seeding 'reject' places the cursor on the decline row while marking the
       still-unapproved plan as the current state — Enter must never approve.
       Digits only move the cursor: approving a plan, like granting a tool,
       always takes an explicit Enter on the focused decision. */
    ui.list({ id: 'decision', role: 'choose', acceptActionId: 'decide', numbered: 'focus', selectedIds: ['reject'], items: [
      { id: 'reject', label: choices.decline.label, ...choices.decline.description === undefined ? {} : { detail: choices.decline.description } },
      { id: 'approve', label: choices.approve.label, ...choices.approve.description === undefined ? {} : { detail: choices.approve.description } },
    ] }),
    ui.actions({ id: 'decision-actions', items: [
      { id: 'copy-plan', label: t('Copy plan'), key: 'c' },
    ] }),
    planReviewFeedback(t),
    scrollHint(t),
  ])
}

/** The 'Other' input replaces the decision controls in place — same surface,
 *  same page — so typing starts immediately without tab navigation. */
export function planReviewFeedback(t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.form({ id: 'revision', enterSubmits: 'send-feedback', fields: [{ kind: 'input', id: 'reason', label: t('Revise'), value: '' }] }),
    ui.actions({ id: 'feedback-actions', reveal: 'focus', items: [
      { id: 'decide', label: t('Confirm'), read: [{ pagePath: [], formId: 'revision' }], selections: [{ pagePath: [], controlId: 'decision' }] },
      { id: 'send-feedback', label: t('Submit'), read: [{ pagePath: [], formId: 'revision' }] },
    ] }),
  ])
}

export function planReviewAnswer(question: AskUserQuestionItem, choices: PlanReviewChoices, event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind !== 'activate' || (event.actionId !== 'send-feedback' && event.actionId !== 'decide')) return undefined
  const selection = event.inputs?.selections?.find(value => value.controlId === 'decision')?.selectedIds[0]
  if (event.actionId === 'decide' && selection === 'approve') return { answers: [{ id: question.id, selected: [choices.approve.label] }] }
  const reason = event.inputs?.forms[0]?.fields.find(field => field.id === 'reason')?.value
  // Empty revision submissions keep the decision open with inline feedback.
  return typeof reason === 'string' && reason.length > 0 ? { answers: [{ id: question.id, selected: [], custom: reason }] } : event.actionId === 'decide' && selection === 'reject' ? { answers: [{ id: question.id, selected: [choices.decline.label] }] } : undefined
}

/** Empty revisions report inline feedback; copying writes the plan markdown to the clipboard. */
export async function planReviewAction(question: AskUserQuestionItem, _choices: PlanReviewChoices, event: MayflyUiEvent, t: MayflyTranslate): Promise<MayflyUiActionReply | undefined> {
  if (event.kind === 'activate' && event.actionId === 'send-feedback') return { kind: 'failed', message: t('Enter feedback to revise the plan') }
  if (event.kind !== 'activate' || event.actionId !== 'copy-plan') return undefined
  try {
    await copyTextToClipboard(question.detail ?? '')
    return { kind: 'completed', feedback: { message: t('Plan copied to clipboard'), severity: 'success' } }
  } catch (error) {
    return { kind: 'completed', feedback: { message: t('Plan copy failed'), severity: 'error', detail: error instanceof Error ? error.message : String(error) } }
  }
}
