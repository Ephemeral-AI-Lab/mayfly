/** Readonly reference Todo checklist, history filtering and completion summary. @module */
import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { itemSummary, viewPanel } from './view-items.ts'

/** Native readonly checklist row supplied by each frontend owner. */
export interface TodoPresentationItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}
/** How long the settled checklist summary remains visible. */
export const TODO_DONE_LINGER_MS = 5000

/** Build semantic spans for one todo row. */
function todoSpans(todo: TodoPresentationItem): readonly MayflyInlineSpan[] {
  switch (todo.status) {
    case 'completed':
      return [{ text: '  ✓ ', tone: 'success' }, { text: todo.content, tone: 'muted' }]
    case 'in_progress':
      return [{ text: '  ● ', tone: 'accent', styles: ['strong'] }, { text: todo.content }]
    case 'pending':
      return [{ text: '  ○ ', tone: 'muted' }, { text: todo.content }]
  }
}


/** What the view renders from. */
export interface TodoState {
  /** The latest whole-list snapshot while it is unfinished; empty until the first `todo/write` and after it settles. */
  readonly todos: readonly TodoPresentationItem[]
  /** Whether the latest run failed or was stopped while the list was unsettled. */
  readonly interrupted: boolean
  /** Whether finished items are listed in the panel (the `viewHistory` setting). */
  readonly history: boolean
  /** The list that just settled: how many items it had; it leaves the row after {@link TODO_DONE_LINGER_MS}. */
  readonly done?: { readonly total: number }
}

/**
 * The item in the row: its mark, `todo`, and how many are done of the list: `● todo 2/12`. Just
 * settled it is `✓ todo 12/12`. The item in progress and the rest are the panel's.
 * @param state - the list.
 * @param t - translator for the label.
 * @returns the summary, or `null` for no list.
 */
export function todoSummary(state: TodoState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) {
    const { total } = state.done
    return { node: itemSummary({ text: '✓', tone: 'success' }, t('todo'), total, total) }
  }
  if (state.todos.length === 0) return null
  const done = state.todos.filter(todo => todo.status === 'completed').length
  return { node: itemSummary({ text: '●', tone: 'accent' }, t('todo'), done, state.todos.length) }
}

/**
 * The panel: every row of the list in the fixed-length scroll every item shares (the count below the window on its last
 * row), with no heading, count, or time. Without history the completed items are not rows; a run
 * that failed or was stopped while the list was unfinished starts with a muted `interrupted`. There is no panel once
 * the list has settled.
 * @param state - the list.
 * @param t - translator for the words.
 * @returns the panel node, or `null` for no unfinished list.
 */
export function todoPanel(state: TodoState, t: MayflyTranslate): MayflyUiNode | null {
  if (state.todos.length === 0) return null
  const listed = state.history ? state.todos : state.todos.filter(todo => todo.status !== 'completed')
  return viewPanel('todo-panel', [
    ...state.interrupted ? [ui.text(`  ${t('interrupted')}`, { tone: 'muted' })] : [],
    ...listed.map(todo => ui.richText(todoSpans(todo))),
  ])
}

