/** Native question declarations and answer encoding over the shared wizard.
 * @module @ephemeral-ai/mayfly/interaction/questionnaire
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { MayflyPagePath, MayflyUiEvent, MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'
import { QUESTION_LIST, QUESTION_OTHER, QUESTION_WIZARD, questionWizard } from '../components/question-wizard.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'

const pathOf = (questions: readonly AskUserQuestionItem[], id: string): MayflyPagePath =>
  questions.length === 1 ? [] : [{ controlId: QUESTION_WIZARD, itemId: id }]

export function questionnaireView(questions: readonly AskUserQuestionItem[], t: MayflyTranslate): MayflySurfaceNode {
  if (questions.length === 0) throw new Error('A questionnaire requires at least one question')
  return questionWizard(questions, {
    title: t('Questions'), other: t('Other'), answer: t('Answer'), placeholder: t('type your own answer'),
    multiHint: t('select all that apply · Space toggles'), review: t('Review'), skipped: t('— skipped'), submit: t('Submit answers'),
  })
}

export function questionnaireAnswer(questions: readonly AskUserQuestionItem[], event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind !== 'submit') return undefined
  return { answers: questions.map(question => {
    const path = pathOf(questions, question.id)
    const selection = event.submission.selections?.find(entry => entry.controlId === QUESTION_LIST && entry.pagePath.length === path.length && entry.pagePath.every((segment, index) => segment.controlId === path[index]!.controlId && segment.itemId === path[index]!.itemId))
    const ids = selection?.selectedIds ?? []
    const custom = selection?.inputs?.[QUESTION_OTHER]
    const typed = typeof custom === 'string' && custom.length > 0
    const selected = (question.options ?? []).filter((_, index) => ids.includes(String(index))).map(option => option.label)
    return { id: question.id, selected: typed && question.multiSelect !== true ? [] : selected, ...typed ? { custom } : {} }
  }) }
}
