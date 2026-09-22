/** Native question declarations and answer encoding over shared wizard forms.
 * @module @ephemeral-ai/mayfly/interaction/questionnaire
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { ui, type MayflyFormAddress, type MayflyPagePath, type MayflySelectionAddress, type MayflyUiEvent, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'

const STEPS = 'questions'
const pathOf = (questions: readonly AskUserQuestionItem[], id: string): MayflyPagePath =>
  questions.length === 1 ? [] : [{ controlId: STEPS, itemId: id }]
const address = (questions: readonly AskUserQuestionItem[], id: string): MayflyFormAddress => ({ pagePath: pathOf(questions, id), formId: 'answer' })
const selection = (questions: readonly AskUserQuestionItem[], id: string): MayflySelectionAddress => ({ pagePath: pathOf(questions, id), controlId: 'options' })
const withOptions = (questions: readonly AskUserQuestionItem[]) => questions.filter(question => (question.options ?? []).length > 0)

export function questionnaireView(questions: readonly AskUserQuestionItem[], t: MayflyTranslate): MayflyUiNode {
  if (questions.length === 0) throw new Error('A questionnaire requires at least one question')
  const selections = withOptions(questions).map(question => selection(questions, question.id))
  const submit = questions.map(question => address(questions, question.id))
  return ui.stack.column([
    ...questions.length === 1 ? [] : [ui.tabs({ id: STEPS, mode: 'wizard', activeId: questions[0]!.id, items: questions.map((question, index) => ({ id: question.id, label: question.header ?? `Q${index + 1}` })) })],
    ...questions.map((question, index) => {
      const last = index === questions.length - 1
      const options = (question.options ?? []).map((option, optionIndex) => ({ id: String(optionIndex), label: option.label, ...(option.description === undefined ? {} : { detail: option.description }) }))
      const navigation = [
        ...index === 0 ? [] : [{ id: 'previous', label: t('Back'), key: 'left', navigate: pathOf(questions, questions[index - 1]!.id) }],
        ...last ? [] : [{ id: 'next', label: t('Next'), key: 'right', read: [address(questions, question.id)], navigate: pathOf(questions, questions[index + 1]!.id) }],
        ...last && questions.length > 1 ? [{ id: 'submit-answers', label: t('Submit answers'), intent: 'primary' as const, submit, ...selections.length === 0 ? {} : { selections } }] : [],
      ]
      return ui.child(ui.stack.column([
        ui.text(question.question, { tone: 'accent' }),
        ...question.detail === undefined ? [] : [ui.scroll(ui.markdown(question.detail), { scrollbar: true })],
        ...options.length === 0 ? [] : [ui.list({ id: 'options', role: 'choose', ...question.multiSelect === true ? { mode: 'multiple' as const } : {}, selectedIds: [],
          items: question.multiSelect === true ? options : [...options, { id: 'none', label: t('No selection') }],
          acceptActionId: last ? 'submit-answers' : 'next' })],
        ui.form({ id: 'answer', fields: [{ kind: 'textarea', id: 'custom', label: t(options.length === 0 ? 'Answer' : 'Other'), value: '' }] }),
        ...navigation.length === 0 ? [] : [ui.actions({ id: 'navigation', items: navigation })],
      ]), questions.length === 1 ? {} : { tab: { controlId: STEPS, itemId: question.id } })
    }),
    ui.actions({ id: 'question-actions', items: [
      { id: 'submit-answers', label: t('Submit answers'), submit, ...selections.length === 0 ? {} : { selections } },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ])
}

export function questionnaireAnswer(questions: readonly AskUserQuestionItem[], event: MayflyUiEvent): AskUserQuestionAnswer | undefined {
  if (event.kind !== 'submit' || event.submission.actionId !== 'submit-answers') return undefined
  return { answers: questions.map(question => {
    const path = pathOf(questions, question.id)
    const form = event.submission.forms.find(form => form.formId === 'answer' && form.pagePath.length === path.length && form.pagePath.every((segment, index) => segment.controlId === path[index]!.controlId && segment.itemId === path[index]!.itemId))
    if (form === undefined) throw new Error('A question answer is missing')
    const custom = form.fields.find(field => field.id === 'custom')?.value
    const ids = event.submission.selections?.find(entry => entry.controlId === 'options' && entry.pagePath.length === path.length && entry.pagePath.every((segment, index) => segment.controlId === path[index]!.controlId && segment.itemId === path[index]!.itemId))?.selectedIds ?? []
    const selected = (question.options ?? []).filter((_, index) => ids.includes(String(index))).map(option => option.label)
    return { id: question.id, selected: typeof custom === 'string' && custom.length > 0 && question.multiSelect !== true ? [] : selected, ...typeof custom === 'string' && custom.length > 0 ? { custom } : {} }
  }) }
}
