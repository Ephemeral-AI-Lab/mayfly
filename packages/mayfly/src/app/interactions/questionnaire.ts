/**
 * Remote question declarations and structured answer encoding over the shared wizard.
 * @module @ephemeral-ai/mayfly/app/interactions/questionnaire
 */

import type { MayflyPagePath, MayflyTranslate, MayflyUiEvent, MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'
import type { QuestionAnswer, QuestionRequest } from './official.ts'
import { QUESTION_LIST, QUESTION_OTHER, QUESTION_WIZARD, questionWizard } from './question-wizard.ts'

type Questions = QuestionRequest['questions']

const pathOf = (questions: Questions, id: string): MayflyPagePath =>
  questions.length === 1 ? [] : [{ controlId: QUESTION_WIZARD, itemId: id }]

export function questionnaireView(questions: Questions, t: MayflyTranslate, remaining?: string): MayflySurfaceNode {
  if (questions.length === 0) throw new Error('A questionnaire requires at least one question')
  return questionWizard(questions, {
    title: t('Questions'), other: t('Other'), answer: t('Answer'), placeholder: t('type your own answer'),
    multiHint: t('select all that apply · Space toggles'), review: t('Review'), skipped: t('— skipped'), submit: t('Submit answers'),
    ...remaining === undefined ? {} : { remaining },
  })
}

export function questionnaireAnswer(questions: Questions, event: MayflyUiEvent): QuestionAnswer | undefined {
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
