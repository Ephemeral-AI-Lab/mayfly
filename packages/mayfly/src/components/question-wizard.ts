/**
 * The question panel: one wizard step per question, a review page when there are several, and no buttons. A question is a
 * numbered choose list whose last row, `Other`, is typed in place; digits answer at once, `Enter` takes the answer and moves
 * on, and a question left unanswered reads `— skipped` on the review page. The component is a pure function of the
 * questions and the words it shows; the surface model holds every draft.
 * @module @ephemeral-ai/mayfly/components/question-wizard
 */
import { patterns, ui, type MayflySurfaceNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** What the component reads of a question. */
export interface QuestionFacts {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string, readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** The words of the panel, already in the reader's language. */
export interface QuestionLabels {
  readonly title: string
  /** The `Other` row of a question that has options, and the row of one that has none. */
  readonly other: string
  readonly answer: string
  readonly placeholder: string
  readonly multiHint: string
  readonly review: string
  readonly skipped: string
  readonly submit: string
}

/** The wizard's id, its steps' list, and the typed row: the ids a submission is read by. */
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
      numbered: options.length > 0, marks: true, ...multiple ? { mode: 'multiple' as const } : {},
      acceptActionId: patterns.wizardNext(QUESTION_WIZARD, stepId),
    }),
  ])
}

/** The panel for one request: the questions in order, then (for several) the review page. */
export function questionWizard(questions: readonly QuestionFacts[], labels: QuestionLabels): MayflySurfaceNode {
  const several = questions.length > 1
  return patterns.wizard({
    id: QUESTION_WIZARD,
    title: labels.title,
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
  })
}
