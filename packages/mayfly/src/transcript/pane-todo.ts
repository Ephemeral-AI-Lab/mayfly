/**
 * `mayfly-pane-todo` plugin: the Todo item of the status row, a views pane over the exact selected Session's native
 * `todos` projection. The projection is the standing plan — the latest whole `todo/write` list, cleared when the next
 * turn starts, with `turn/end` keeping the finished checklist visible. The conversation projection routes `todo_write`
 * calls away from transcript presentation, so this view is the list's only surface. While the list is unfinished the
 * row carries `● todo 2/12` (done over total); the panel, shown under the row while the view is entered (`Alt+↓`), is
 * every row of the list in the fixed-length scroll every item shares, with no heading, count, or time; with the
 * `viewHistory` setting off the completed rows are not listed. When every entry is completed the row holds
 * `✓ todo 12/12` for a few seconds, and then the view leaves. A session without any `todo/write` has no Todo view.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyInlineSpan, type MayflyPaneSummary, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { SessionFactsService } from './session-facts.ts'
import type { TickSource } from './tick.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { followViewHistory, itemSummary, viewPanel } from './view-items.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-todo'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts', 'mayflyTick', 'sessionProjections']

/** The Todo view's id: the pane id the views lane keeps it under. */
export const TODO_VIEW_ID = 'mayfly.view.todo'

/** The Todo view's place in the status row: after the model, the chips, the directory, git, agents, jobs, and goal. */
const VIEW_PRIORITY = 14

/** How long the closing item `✓ todo 6/6` stays before the view leaves. */
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
  /** The list that just settled: how many items it had; it leaves the row after {@link DONE_LINGER_MS}. */
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

/**
 * Mount the Todo view over the current projection-backed facts. A current session identity change clears the previous
 * list before the new whole-value facts arrive. The shared tick ends the closing line's stay. Unloading the fiber unmounts the view and stops the tick.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let todos: readonly TodoItem[] = []
  let interrupted = false
  /** Whether an unfinished list has been seen, so one that loads already finished shows nothing. */
  let tracking = false
  let done: { readonly total: number, readonly at: number } | undefined
  let now = Date.now()
  let published = ''
  /** The built summary and panel for the inputs that produce them; a same-identity list reuses both. */
  let built: {
    readonly todos: readonly TodoItem[]
    readonly interrupted: boolean
    readonly history: boolean
    readonly doneTotal: number | undefined
    readonly summary: MayflyPaneSummary | null
    readonly panel: MayflyUiNode | null
  } | undefined
  const t = transcriptTranslator(ctx, 'transcript')
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  const pane = ctx.mayflyPanes.register({ id: TODO_VIEW_ID, title: t('Todo'), placement: 'views', priority: VIEW_PRIORITY }, null)
  const view = followViewHistory(ctx, () => publish())
  // The clock runs while the closing line is up; the view keeps no timer of its own.
  let offTick: (() => void) | undefined
  const syncTick = (): void => {
    if (done === undefined) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => {
      now = at
      if (done !== undefined && at - done.at >= DONE_LINGER_MS) done = undefined
      publish()
    })
  }
  const publish = (): void => {
    syncTick()
    const history = view.history()
    if (built === undefined
      || built.todos !== todos
      || built.interrupted !== interrupted
      || built.history !== history
      || built.doneTotal !== done?.total) {
      const state: TodoState = {
        todos, interrupted, history,
        ...done === undefined ? {} : { done: { total: done.total } },
      }
      built = { todos, interrupted, history, doneTotal: done?.total, summary: todoSummary(state, t), panel: todoPanel(state, t) }
    }
    const { summary, panel } = built
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const update = (next: readonly TodoItem[], stopped = interrupted, force = false): void => {
    // An unrelated facts delta carries the same projection: nothing to rebuild or publish.
    if (!force && next === todos && stopped === interrupted) return
    now = Date.now()
    const settled = next.length > 0 && next.every(todo => todo.status === 'completed')
    interrupted = stopped
    if (settled) {
      // A list that was being tracked has just finished; one that loads already finished has nothing to show.
      if (tracking) done = { total: next.length, at: now }
      todos = []
      tracking = false
    } else {
      todos = next
      if (next.length === 0) tracking = false
      else {
        tracking = true
        done = undefined
      }
    }
    publish()
  }

  const facts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let session: Session | undefined = facts?.currentAgent?.session
  /* The native `todos` projection is the whole list, or null before the first
     write and after the next turn clears it. */
  const readTodos = (target: Session | undefined): readonly TodoItem[] => {
    if (target === undefined) return []
    const value = ctx.sessionProjections.snapshot(target, ['todos']).values.todos
    return Array.isArray(value) ? value : []
  }
  const offAgent = facts?.subscribeAgent((agent) => {
    if (agent?.session === session) return
    session = agent?.session
    done = undefined
    update([], false, true)
    update(readTodos(session), false)
  })
  const offFacts = facts?.subscribe(next => {
    update(todos, !next.active && next.runOutcome === 'failed')
  })
  const offProjection = ctx.sessionProjections.onChanged((changed, key, value) => {
    if (key !== 'todos' || changed !== session) return
    update(Array.isArray(value) ? value : [], interrupted)
  })
  const offLocale = observeTranscriptLocale(ctx, () => {
    // The cached summary and panel embed translated strings: rebuild them for the new catalog.
    built = undefined
    published = ''
    publish()
  })
  // The attach subscription reports the current Agent; take its list once here
  // as well, since no projection change fires for a value already in place.
  update(readTodos(session), interrupted)
  ctx.effect(() => () => {
    offAgent?.()
    offFacts?.()
    offProjection()
    offTick?.()
    offLocale()
    pane.dispose()
  })
}
