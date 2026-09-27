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
    ui.list({ id: 'decision', role: 'choose', numbered: 'focus', selectedIds: ['reject'], items: [
      { id: 'approve', label: choices.approve.label, ...choices.approve.description === undefined ? {} : { detail: choices.approve.description } },
      { id: 'reject', label: choices.decline.label, ...choices.decline.description === undefined ? {} : { detail: choices.decline.description } },
      { id: 'other', label: t('Other'), detail: t('Type feedback to revise the plan') },
    ] }),
    ui.actions({ id: 'decision-actions', items: [
      { id: 'copy-plan', label: t('Copy plan'), key: 'c' },
      /* 'o' reaches the feedback input in one keypress even when the third
         list row clips under tight height caps. */
      { id: 'other-plan', label: t('Other'), key: 'o' },
    ] }),
    scrollHint(t),
  ])
}

/** The 'Other' input replaces the decision controls in place — same surface,
 *  same page — so typing starts immediately without tab navigation. */
export function planReviewFeedback(t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.text(t('Tell the model what to change')),
    ui.form({ id: 'revision', enterSubmits: 'send-feedback', fields: [{ kind: 'textarea', id: 'reason', label: t('Feedback'), value: '' }] }),
    ui.actions({ id: 'feedback-actions', items: [
      /* Reading the field keeps the submission an ordinary activate event:
         a submit acknowledgement could never swap the form back out. */
      { id: 'send-feedback', label: t('Submit'), read: [{ pagePath: [], formId: 'revision' }] },
      { id: 'back', label: t('Back') },
    ] }),
    scrollHint(t),
  ])
}

export function planReviewAnswer(question: AskUserQuestionItem, choices: PlanReviewChoices, event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind === 'selection-accept' && event.controlId === 'decision') {
    const id = event.selectedIds[0]
    if (id === 'approve') return { answers: [{ id: question.id, selected: [choices.approve.label] }] }
    if (id === 'reject') return { answers: [{ id: question.id, selected: [choices.decline.label] }] }
    return undefined
  }
  if (event.kind !== 'activate' || event.actionId !== 'send-feedback') return undefined
  const reason = event.inputs?.forms[0]?.fields.find(field => field.id === 'reason')?.value
  /* An empty read means the user changed their mind; leave the request open
     for `planReviewAction` to restore the decision controls. */
  return typeof reason === 'string' && reason.length > 0 ? { answers: [{ id: question.id, selected: [], custom: reason }] } : undefined
}

/** Non-settling controls: 'Other' swaps in the feedback input, 'back' (or an
 *  empty feedback read) restores the decisions, copying writes the plan markdown
 *  to the clipboard. Node replies arrive unframed; requestOverlay wraps them
 *  in the request chrome before publication. */
export async function planReviewAction(question: AskUserQuestionItem, choices: PlanReviewChoices, event: MayflyUiEvent, t: MayflyTranslate): Promise<MayflyUiActionReply | undefined> {
  if (event.kind === 'selection-accept' && event.controlId === 'decision' && event.selectedIds[0] === 'other') return { kind: 'accepted', node: planReviewFeedback(t), source: [] }
  if (event.kind === 'activate' && event.actionId === 'other-plan') return { kind: 'accepted', node: planReviewFeedback(t), source: [] }
  if (event.kind === 'activate' && event.actionId === 'back') return { kind: 'accepted', node: planReviewControls(question, choices, t), source: [] }
  if (event.kind === 'activate' && event.actionId === 'send-feedback') return { kind: 'accepted', node: planReviewControls(question, choices, t), source: [] }
  if (event.kind !== 'activate' || event.actionId !== 'copy-plan') return undefined
  try {
    await copyTextToClipboard(question.detail ?? '')
    return { kind: 'completed', feedback: { message: t('Plan copied to clipboard'), severity: 'success' } }
  } catch (error) {
    return { kind: 'completed', feedback: { message: t('Plan copy failed'), severity: 'error', detail: error instanceof Error ? error.message : String(error) } }
  }
}
