/**
 * `mayfly-pane-todo` plugin: the Todo view of status row 2, a views pane over the attached session's todo list. The
 * list comes from the replay/live whole value exposed by `mayflySessionFacts`, backed by the official
 * `mayflyConversationFacts` projection. The conversation projection routes `todo_write` calls away from transcript
 * presentation, so this view is the list's only surface. While the list is unfinished the row carries `● todo 2/12 4m 12s`
 * (done over total, and the time the list has been tracked); the panel, shown under the row while the view is entered
 * (`Alt+↓`), is every row of the list in the fixed-length scroll every item shares, with no heading, count, or time;
 * with the `viewHistory` setting off the completed rows are not listed. When every entry is completed the row holds
 * `✓ todo 12/12 12s` for a few seconds, and then the view leaves. A session without any `todo/write` has no Todo view.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { ConversationFacts } from '../conversation/types.ts'
import type { SessionFactsService } from './session-facts.ts'
import type { TickSource } from './tick.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { followViewHistory, itemSummary, viewPanel } from './view-items.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-todo'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts', 'mayflyTick']

/** The Todo view's id: the pane id the views lane keeps it under. */
export const TODO_VIEW_ID = 'mayfly.view.todo'

/** The Todo view's place in the status row: after the model, the chips, the directory, git, agents, jobs, and goal. */
const VIEW_PRIORITY = 14

/** How long the closing item `✓ todo 6/6 4m 12s` stays before the view leaves. */
export const DONE_LINGER_MS = 5000

/** Build semantic spans for one todo row. */
function todoSpans(todo: TodoItem): readonly MayflyInlineSpan[] {
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
  readonly todos: readonly TodoItem[]
  /** Whether the latest run failed or was stopped while the list was unsettled. */
  readonly interrupted: boolean
  /** Whether finished items are listed in the panel (the `viewHistory` setting). */
  readonly history: boolean
  /** How long the unfinished list has been tracked, in milliseconds. */
  readonly elapsedMs: number
  /** The list that just settled: how many items it had and how long it took; it leaves the row after {@link DONE_LINGER_MS}. */
  readonly done?: { readonly total: number, readonly elapsedMs: number }
}

/**
 * The row-2 summary: its mark, `todo`, how many are done of the list, and the elapsed time: `● todo 2/12 4m 12s`. Just
 * settled it is `✓ todo 12/12 12s`. The item in progress and the rest are the panel's.
 * @param state - the list.
 * @param t - translator for the label.
 * @returns the summary, or `null` for no list.
 */
export function todoSummary(state: TodoState, t: MayflyTranslate): MayflyPaneSummary | null {
  if (state.done !== undefined) {
    const { total, elapsedMs } = state.done
    return { node: itemSummary({ text: '✓', tone: 'success' }, t('todo'), total, total, elapsedMs) }
  }
  if (state.todos.length === 0) return null
  const done = state.todos.filter(todo => todo.status === 'completed').length
  return { node: itemSummary({ text: '●', tone: 'accent' }, t('todo'), done, state.todos.length, state.elapsedMs) }
}

/**
 * The panel: every row of the list in the fixed-length scroll every item shares (the count below the window on its last
 * row), with no heading, count, or time (the cell says them). Without history the completed items are not rows; a run
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

/**
 * Mount the Todo view over the current projection-backed facts. A current session identity change clears the previous
 * list before the new whole-value facts arrive. The shared tick republishes the elapsed time while a list is tracked
 * and ends the closing line's stay. Unloading the fiber unmounts the view and stops the tick.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let todos: readonly TodoItem[] = []
  let interrupted = false
  let startedAt: number | undefined
  let done: { readonly total: number, readonly elapsedMs: number, readonly at: number } | undefined
  let now = Date.now()
  let published = ''
  const t = transcriptTranslator(ctx, 'transcript')
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  const pane = ctx.mayflyPanes.register({ id: TODO_VIEW_ID, title: t('Todo'), placement: 'views', priority: VIEW_PRIORITY }, null)
  const view = followViewHistory(ctx, () => publish())
  // The clock runs while a list is tracked or its closing line is up; the view keeps no timer of its own.
  let offTick: (() => void) | undefined
  const syncTick = (): void => {
    const needed = startedAt !== undefined || done !== undefined
    if (!needed) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => {
      now = at
      if (done !== undefined && at - done.at >= DONE_LINGER_MS) done = undefined
      publish()
    })
  }
  const publish = (): void => {
    syncTick()
    const state: TodoState = {
      todos, interrupted, history: view.history(),
      elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
      ...done === undefined ? {} : { done: { total: done.total, elapsedMs: done.elapsedMs } },
    }
    const summary = todoSummary(state, t)
    const panel = todoPanel(state, t)
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const update = (next: readonly TodoItem[], stopped = interrupted): void => {
    now = Date.now()
    const settled = next.length > 0 && next.every(todo => todo.status === 'completed')
    interrupted = stopped
    if (settled) {
      // A list that was being tracked has just finished; one that loads already finished has nothing to show.
      if (startedAt !== undefined) done = { total: next.length, elapsedMs: now - startedAt, at: now }
      todos = []
      startedAt = undefined
    } else {
      todos = next
      if (next.length === 0) startedAt = undefined
      else {
        startedAt ??= now
        done = undefined
      }
    }
    publish()
  }

  const facts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let sessionId = facts?.currentAgent?.id
  const offAgent = facts?.subscribeAgent((agent) => {
    if (agent?.id === sessionId) return
    sessionId = agent?.id
    done = undefined
    update([], false)
  })
  const offFacts = facts?.subscribe((next: ConversationFacts) => {
    update(next.todos, !next.active && next.runOutcome === 'failed')
  })
  const offLocale = observeTranscriptLocale(ctx, () => { published = ''; publish() })
  ctx.effect(() => () => {
    offAgent?.()
    offFacts?.()
    offTick?.()
    offLocale()
    pane.dispose()
  })
}
