/** Native question requests use shared wizard forms or plan review decisions.
 * @module @ephemeral-ai/mayfly/interaction/questions-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { decisionArmMs, freezeWire } from '@ephemeral-ai/mayfly-ui'
import { openInEditor } from './decision-actions.ts'
import { planReviewAction, planReviewAnswer, planReviewCard, planReviewChoices } from './plan-review-panel.ts'
import { questionnaireAnswer, questionnaireView } from './questionnaire.ts'
import { interactionTranslator, mountInteractionLocale } from './locale.ts'
import { requestOverlay } from './request-overlay.ts'

export const name = 'mayfly-questions'
export const inject = ['mayflyOverlays', 'mayflyCurrentAgent', 'userQuestions', 'mayflyScreen']

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  let sequence = 0
  ctx.on('user-questions/request', (request, next) => {
    if (request.agent !== undefined && ctx.mayflyCurrentAgent.current() !== request.agent) return next()
    const questions = freezeWire(request.questions)
    const single = questions.length === 1 ? questions[0] : undefined
    const choices = single === undefined ? undefined : planReviewChoices(single)
    const t = interactionTranslator(ctx)
    const id = `mayfly.questions.${++sequence}`
    const review = single !== undefined && choices !== undefined
    /* A plan review is a request in the stream, the plan open as its block, and its decision a card in the editor's place. */
    if (review) ctx.emit('mayfly/decision-requests-changed', 'plan', [{ type: 'plan', toolName: single.header ?? 'plan', ...single.intent?.callId === undefined ? {} : { callId: String(single.intent.callId) } }])
    ctx.emit('mayfly/decision-wait-changed', { kind: review ? 'approval' : 'answer' })
    return requestOverlay(ctx, {
      id, title: () => review ? single.header ?? t('Plan review') : t('Questions'),
      ...review ? { dismissal: 'discard', bare: true, contentScroll: true, armMs: decisionArmMs } : { bare: true },
      ...request.agent === undefined ? {} : { agent: request.agent },
      ...request.signal === undefined ? {} : { signal: request.signal },
      view: () => review ? planReviewCard(t) : questionnaireView(questions, t),
      answer: event => review ? planReviewAnswer(single, choices, event) : questionnaireAnswer(questions, event),
      ...review ? { onAction: async (event, context) => event.kind === 'activate' && event.actionId === 'open' ? openInEditor(ctx, single.detail ?? '', t, context.signal) : planReviewAction(single, event, t) } : {},
      cancelled: (reason) => {
        // `Esc` on a plan review declines it, as the card says; anything else that ends the request is a cancellation.
        if (review && reason === 'dismiss') return { answers: [{ id: single.id, selected: [choices.decline.label] }] }
        throw new UserQuestionError(reason === 'dismiss' ? 'ask_user_question was dismissed' : 'ask_user_question was aborted before the user answered', reason === 'dismiss' ? 'ASK_CANCELLED' : 'ASK_ABORTED')
      },
    }).result.finally(() => {
      if (review) ctx.emit('mayfly/decision-requests-changed', 'plan', [])
      ctx.emit('mayfly/decision-wait-changed', undefined)
    })
  })
}
