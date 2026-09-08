/** Native question declarations and answer encoding over shared wizard forms.
 * @module @ephemeral-ai/mayfly/interaction/questionnaire
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { ui, type MayflyFormAddress, type MayflyUiEvent, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'

const STEPS = 'questions'
const address = (id: string): MayflyFormAddress => ({ pagePath: [{ controlId: STEPS, itemId: id }], formId: 'answer' })

export function questionnaireView(questions: readonly AskUserQuestionItem[], t: MayflyTranslate): MayflyUiNode {
  if (questions.length === 0) throw new Error('A questionnaire requires at least one question')
  return ui.stack.column([
    ui.tabs({ id: STEPS, mode: 'wizard', activeId: questions[0]!.id, items: questions.map((question, index) => ({ id: question.id, label: question.header ?? `Q${index + 1}` })) }),
    ...questions.map((question, index) => {
      const options = (question.options ?? []).map((option, optionIndex) => ({ id: String(optionIndex), label: option.label, ...(option.description === undefined ? {} : { detail: option.description }) }))
      return ui.child(ui.stack.column([
        ui.text(question.question, { tone: 'accent' }),
        ...question.detail === undefined ? [] : [ui.scroll(ui.markdown(question.detail), { scrollbar: true })],
        ui.form({ id: 'answer', fields: [
          ...options.length === 0 ? [] : question.multiSelect === true
            ? [{ kind: 'multiselect' as const, id: 'selected', label: t('Answer'), value: [], options }]
            : [{ kind: 'select' as const, id: 'selected', label: t('Answer'), value: null, options: [{ id: 'none', label: t('No selection') }, ...options] }],
          { kind: 'textarea', id: 'custom', label: t(options.length === 0 ? 'Answer' : 'Other'), value: '' },
        ] }),
        ui.actions({ id: 'navigation', items: [
          ...index === 0 ? [] : [{ id: 'previous', label: t('Back'), navigate: address(questions[index - 1]!.id).pagePath }],
          ...index === questions.length - 1 ? [] : [{ id: 'next', label: t('Next'), read: [address(question.id)], navigate: address(questions[index + 1]!.id).pagePath }],
        ] }),
      ]), { tab: { controlId: STEPS, itemId: question.id } })
    }),
    ui.actions({ id: 'question-actions', items: [
      { id: 'submit-answers', label: t('Submit answers'), submit: questions.map(question => address(question.id)) },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ])
}

export function questionnaireAnswer(questions: readonly AskUserQuestionItem[], event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind !== 'submit' || event.submission.actionId !== 'submit-answers') return undefined
  return { answers: questions.map(question => {
    const form = event.submission.forms.find(form => form.formId === 'answer' && form.pagePath.length === 1 && form.pagePath[0]?.controlId === STEPS && form.pagePath[0].itemId === question.id)
    if (form === undefined) throw new Error('A question answer is missing')
    const custom = form.fields.find(field => field.id === 'custom')?.value
    const value = form.fields.find(field => field.id === 'selected')?.value
    const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    const selected = (question.options ?? []).filter((_, index) => ids.includes(String(index))).map(option => option.label)
    return { id: question.id, selected: typeof custom === 'string' && custom.length > 0 && question.multiSelect !== true ? [] : selected, ...typeof custom === 'string' && custom.length > 0 ? { custom } : {} }
  }) }
}
