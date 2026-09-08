/** Native question requests use shared wizard forms or plan review decisions.
 * @module @ephemeral-ai/mayfly/interaction/questions-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import { planReviewAnswer, planReviewChoices, planReviewView } from './plan-review-panel.ts'
import { questionnaireAnswer, questionnaireView } from './questionnaire.ts'
import { interactionTranslator, mountInteractionLocale } from './locale.ts'
import { requestOverlay } from './request-overlay.ts'

export const name = 'mayfly-questions'
export const inject = ['mayflyOverlays', 'mayflyCurrentAgent', 'userQuestions']

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  let sequence = 0
  ctx.on('user-questions/request', (request, next) => {
    if (request.agent !== undefined && ctx.mayflyCurrentAgent.current() !== request.agent) return next()
    const questions = freezeWire(request.questions)
    const single = questions.length === 1 ? questions[0] : undefined
    const choices = single === undefined ? undefined : planReviewChoices(single)
    const t = interactionTranslator(ctx)
    return requestOverlay(ctx, {
      id: `mayfly.questions.${++sequence}`, title: () => single !== undefined && choices !== undefined ? single.header ?? t('Plan review') : t('Questions'),
      ...choices === undefined ? {} : { dismissal: 'discard' },
      ...request.agent === undefined ? {} : { agent: request.agent },
      ...request.signal === undefined ? {} : { signal: request.signal },
      view: () => single !== undefined && choices !== undefined ? planReviewView(single, choices, t) : questionnaireView(questions, t),
      answer: event => single !== undefined && choices !== undefined ? planReviewAnswer(single, choices, event) : questionnaireAnswer(questions, event),
      cancelled: reason => { throw new UserQuestionError(reason === 'dismiss' ? 'ask_user_question was dismissed' : 'ask_user_question was aborted before the user answered', reason === 'dismiss' ? 'ASK_CANCELLED' : 'ASK_ABORTED') },
    }).result
  })
}
