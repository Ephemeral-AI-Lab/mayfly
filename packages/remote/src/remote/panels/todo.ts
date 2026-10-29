/**
 * Current Mayfly Todo summary and checklist panel over the official projection.
 * @module @ephemeral-ai/mayfly/remote/panels/todo
 */

import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { remoteItemSummary, remoteViewPanel } from './view-items.ts'

/** One official Todo projection row. */
export interface RemoteTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Todo view state, including interrupted and short-lived settled presentations. */
export interface RemoteTodoState {
  readonly todos: readonly RemoteTodoItem[]
  readonly interrupted: boolean
  readonly done?: { readonly total: number }
}

function spans(todo: RemoteTodoItem): readonly MayflyInlineSpan[] {
  switch (todo.status) {
    case 'completed': return [{ text: '  ✓ ', tone: 'success' }, { text: todo.content, tone: 'muted' }]
    case 'in_progress': return [{ text: '  ● ', tone: 'accent', styles: ['strong'] }, { text: todo.content }]
    case 'pending': return [{ text: '  ○ ', tone: 'muted' }, { text: todo.content }]
  }
}

/** Build the current Mayfly Todo summary. */
export function remoteTodoSummary(state: RemoteTodoState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) return { node: remoteItemSummary({ text: '✓', tone: 'success' }, t('todo'), state.done.total, state.done.total) }
  if (state.todos.length === 0) return null
  const done = state.todos.filter(todo => todo.status === 'completed').length
  return { node: remoteItemSummary({ text: '●', tone: 'accent' }, t('todo'), done, state.todos.length) }
}

/** Build the complete official checklist without inventing a Remote settings store. */
export function remoteTodoPanel(state: RemoteTodoState, t: MayflyTranslate): MayflyUiNode | null {
  if (state.todos.length === 0) return null
  return remoteViewPanel('todo-panel', [
    ...state.interrupted ? [ui.text(`  ${t('interrupted')}`, { tone: 'muted' })] : [],
    ...state.todos.map(todo => ui.richText(spans(todo))),
  ])
}
