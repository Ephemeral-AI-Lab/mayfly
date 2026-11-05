/**
 * Shared Remote question wizard with optional officially claimed countdown text.
 * @module @ephemeral-ai/mayfly/remote/interactions/question-wizard
 */

import { decisionLane, ui, wizard, wizardNext, type MayflySurfaceNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

interface QuestionFacts {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string, readonly description?: string }[]
  readonly multiSelect?: boolean
}

interface QuestionLabels {
  readonly title: string
  readonly other: string
  readonly answer: string
  readonly placeholder: string
  readonly multiHint: string
  readonly review: string
  readonly skipped: string
  readonly submit: string
  readonly remaining?: string
}

export const QUESTION_WIZARD = 'questions'
export const QUESTION_LIST = 'options'
export const QUESTION_OTHER = 'other'

const stepLabel = (question: QuestionFacts, index: number): string => question.header ?? `Q${String(index + 1)}`

function body(question: QuestionFacts, stepId: string, labels: QuestionLabels): MayflyUiNode {
  const options = question.options ?? []
  const multiple = question.multiSelect === true
  const items = [
    ...options.map((option, index) => ({ id: String(index), label: option.label, ...option.description === undefined ? {} : { detail: option.description } })),
    { id: QUESTION_OTHER, label: options.length === 0 ? labels.answer : labels.other, input: { placeholder: labels.placeholder } },
  ]
  return ui.stack.column([
    ui.text(question.question, { styles: ['strong'] }),
    ...multiple ? [ui.text(labels.multiHint, { tone: 'muted' })] : [],
    ...question.detail === undefined ? [] : [ui.scroll(ui.markdown(question.detail), { scrollbar: true })],
    ui.list({
      id: QUESTION_LIST, role: 'choose', autofocus: true, selectedIds: [], items,
      numbered: options.length > 0, ...multiple ? { mode: 'multiple' as const, marks: true } : {},
      acceptActionId: wizardNext(QUESTION_WIZARD, stepId),
    }),
  ])
}

/** Build the current Mayfly question wizard; several questions end in the shared review page. */
export function questionWizard(questions: readonly QuestionFacts[], labels: QuestionLabels): MayflySurfaceNode {
  const several = questions.length > 1
  return decisionLane({
    id: QUESTION_WIZARD,
    title: labels.title,
    escapeLabel: 'cancel',
    coverStatus: true,
    ...labels.remaining === undefined ? {} : { badges: [{ text: labels.remaining, tone: 'warning' }] },
    body: wizard({
      id: QUESTION_WIZARD,
      steps: questions.map((question, index) => ({
        id: question.id, label: stepLabel(question, index), body: body(question, question.id, labels), lists: [QUESTION_LIST],
      })),
      ...several ? {
        review: {
          label: labels.review, skippedLabel: labels.skipped, submitLabel: labels.submit,
          items: questions.map((question, index) => ({ stepId: question.id, label: stepLabel(question, index), source: { kind: 'list' as const, controlId: QUESTION_LIST } })),
        },
      } : {},
      hintLabel: 'question',
    }),
  })
}
