/**
 * The Todo item of the status row (`pane-todo`): its summary and panel as pure functions of the list, and the view that
 * follows the exact selected Session's native `todos` projection. Covers the unfinished summary (`● todo 2/12`), the
 * closing item (`✓ todo 12/12`) held five seconds, the fixed-length scrolling panel with no heading or count, the
 * `viewHistory` setting that lists finished rows, the interrupted line, a list that settled before the session loaded,
 * session changes, projection changes, and the Fiber's cleanup.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import * as todo from '../../src/transcript/pane-todo.ts'
import { VIEW_PANEL_ROWS } from '../../src/transcript/view-items.ts'
import { resetSeq, turnEnd, turnStart } from './helpers.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'

const item = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

/** The text of every rich-text span under a node, in order, and the spans themselves. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string, readonly styles?: readonly string[] }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  return [...record.kind === 'rich-text' ? record.spans as never[] : [], ...Object.entries(record).filter(([key]) => key !== 'spans').flatMap(([, value]) => spansOf(value))]
}
/** A summary's words at its full form. */
const fullText = (summary: { readonly node: unknown } | null | undefined): string => spansOf(summary!.node).map(span => span.text).join('')

describe('todoSummary', () => {
  const t = transcriptTranslatorFake
  const state = (todos: TodoItem[], extra: Partial<todo.TodoState> = {}): todo.TodoState => ({ todos, interrupted: false, history: false, ...extra })

  it('has no summary for no list', () => {
    expect(todo.todoSummary(state([]), t)).toBeNull()
  })

  it('says the mark and done over total', () => {
    const list = [...Array.from({ length: 2 }, (_, index) => item(`d${index}`, 'completed')), item('now', 'in_progress'), ...Array.from({ length: 9 }, (_, index) => item(`p${index}`, 'pending'))]
    const summary = todo.todoSummary(state(list), t)!
    expect(fullText(summary)).toBe('● todo 2/12')
    expect(spansOf(summary.node)[0]).toEqual({ text: '●', tone: 'accent' })
  })

  it('closes with the success mark and the whole list once it settles', () => {
    const closing = todo.todoSummary(state([], { done: { total: 12 } }), t)!
    expect(fullText(closing)).toBe('✓ todo 12/12')
    expect(spansOf(closing.node)[0]).toEqual({ text: '✓', tone: 'success' })
  })
})

describe('todoPanel', () => {
  const t = transcriptTranslatorFake
  const list = [item('first', 'completed'), item('now', 'in_progress'), item('next', 'pending')]
  const panel = (todos: TodoItem[], extra: Partial<todo.TodoState> = {}) => todo.todoPanel({ todos, interrupted: false, history: false, ...extra }, t)

  it('has no panel for no list or a settled one', () => {
    expect(panel([])).toBeNull()
  })

  it('is a fixed-length scroll with no heading, count, or time: its rows are the list', () => {
    const node = panel(list, { history: true }) as unknown as { readonly kind: string, readonly id: string, readonly height: number, readonly expandable: boolean, readonly more: boolean, readonly scrollbar: boolean }
    expect(node).toMatchObject({ kind: 'scroll', height: VIEW_PANEL_ROWS, expandable: false, more: true, scrollbar: false })
    expect(spansOf(node).map(span => span.text)).toEqual(['  ✓ ', 'first', '  ● ', 'now', '  ○ ', 'next'])
    expect(spansOf(node).find(span => span.text === 'now')).toEqual({ text: 'now' })
    expect(spansOf(node).find(span => span.text === '  ● ')).toEqual({ text: '  ● ', tone: 'accent', styles: ['strong'] })
    expect(spansOf(node).find(span => span.text === 'first')).toEqual({ text: 'first', tone: 'muted' })
  })

  it('lists the finished rows only with viewHistory, and draws a scrollbar only past the panel length', () => {
    expect(spansOf(panel(list)).map(span => span.text)).toEqual(['  ● ', 'now', '  ○ ', 'next'])
    const long = Array.from({ length: VIEW_PANEL_ROWS + 1 }, (_, index) => item(`t${index}`, 'pending'))
    expect(panel(long)).toMatchObject({ scrollbar: true })
    expect(panel(long.slice(0, VIEW_PANEL_ROWS))).toMatchObject({ scrollbar: false })
  })

  it('starts with a muted `interrupted` when the run failed or was stopped while the list was unfinished', () => {
    expect(JSON.stringify(panel(list, { interrupted: true }))).toContain('"tone":"muted","kind":"text","content":"  interrupted"')
    expect(JSON.stringify(panel(list))).not.toContain('interrupted')
  })
})

/** The native `todos` projection face: a snapshot per Session and the change feed. */
class TodoProjectionFake {
  private readonly values = new Map<object, readonly TodoItem[] | null>()
  private readonly listeners = new Set<(session: unknown, key: string, value: unknown, seq: number) => void>()

  set(session: object, todos: readonly TodoItem[] | null): void {
    this.values.set(session, todos)
  }

  snapshot(session: object): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    return { asOfSeq: 0, values: { todos: this.values.get(session) ?? null } }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(session: object, todos: readonly TodoItem[] | null, seq = 0): void {
    this.values.set(session, todos)
    for (const listener of this.listeners) listener(session, 'todos', todos, seq)
  }
}

interface TodoBootOptions {
  readonly todos?: readonly TodoItem[] | null
  readonly events?: SessionEvent[]
  readonly services?: Record<string, unknown>
}

async function bootTodo(options: TodoBootOptions = {}) {
  const agent = fakeAgent(options.events ?? [])
  const projections = new TodoProjectionFake()
  projections.set(agent.session, options.todos ?? null)
  const tick = new HandTick()
  const harness = await bootPanePlugin(todo, agent, { mayflyTick: tick, sessionProjections: projections, ...options.services })
  const entry = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === todo.TODO_VIEW_ID)!
  const write = (todos: readonly TodoItem[] | null): void => { projections.emit(agent.session, todos) }
  return { ...harness, agent, projections, tick, entry, write }
}

describe('mayfly-pane-todo', () => {
  it('registers a views pane at priority 14 that has no item until the native projection has a list', async () => {
    resetSeq()
    const harness = await bootTodo()
    expect(harness.entry().definition).toMatchObject({ placement: 'views', priority: 14, title: 'Todo' })
    expect(harness.entry().summary).toBeNull()
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('shows done over total and the panel from the latest native whole-list value', async () => {
    resetSeq()
    const harness = await bootTodo()
    harness.write([item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending')])
    expect(fullText(harness.entry().summary)).toBe('● todo 1/3')
    // No clock runs while the list is unfinished.
    expect(harness.tick.subscribers).toBe(0)
    expect(spansOf(harness.entry().node).map(span => span.text)).toEqual(['  ● ', 'b', '  ○ ', 'c'])
    // The last write wins: a whole list replaces the one before it.
    harness.write([item('a', 'completed'), item('b', 'completed'), item('c', 'in_progress')])
    expect(fullText(harness.entry().summary)).toBe('● todo 2/3')
    await harness.dispose()
  })

  it('holds the closing item five seconds when a tracked list settles, then leaves', async () => {
    resetSeq()
    const harness = await bootTodo()
    harness.write([item('a', 'in_progress'), item('b', 'pending')])
    const before = Date.now()
    harness.write([item('a', 'completed'), item('b', 'completed')])
    const after = Date.now()
    expect(fullText(harness.entry().summary)).toBe('✓ todo 2/2')
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(1)
    harness.tick.fire(before + todo.DONE_LINGER_MS - 1)
    expect(harness.entry().summary).not.toBeNull()
    harness.tick.fire(after + todo.DONE_LINGER_MS + 1_000)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    // The next list starts fresh.
    harness.write([item('c', 'pending')])
    expect(fullText(harness.entry().summary)).toBe('● todo 0/1')
    await harness.dispose()
  })

  it('shows nothing for a projection that already settled when the session loaded', async () => {
    resetSeq()
    const harness = await bootTodo({ todos: [item('a', 'completed'), item('b', 'completed')] })
    expect(harness.entry().summary).toBeNull()
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('marks the panel interrupted when the run failed or was stopped with the list unfinished', async () => {
    resetSeq()
    const harness = await bootTodo({ events: [turnStart(1)], todos: [item('a', 'in_progress')] })
    expect(JSON.stringify(harness.entry().node)).not.toContain('interrupted')
    harness.ctx.emit('session/event', harness.agent.session as never, turnEnd(1, { kind: 'failed' } as never))
    expect(JSON.stringify(harness.entry().node)).toContain('"content":"  interrupted"')
    await harness.dispose()
  })

  it('lists finished rows only when the viewHistory setting is on, and follows the setting live', async () => {
    resetSeq()
    const settings = { value: { viewHistory: false } as Record<string, unknown> }
    const harness = await bootTodo({ services: { mayflyInteractionState: { settingsSource: () => settings.value } } })
    harness.write([item('done', 'completed'), item('now', 'in_progress')])
    expect(spansOf(harness.entry().node).map(span => span.text)).toEqual(['  ● ', 'now'])
    settings.value = { viewHistory: true }
    harness.ctx.emit('settings/document-updated', 'mayfly' as never, 1)
    expect(spansOf(harness.entry().node).map(span => span.text)).toEqual(['  ✓ ', 'done', '  ● ', 'now'])
    // Another namespace changing says nothing.
    harness.ctx.emit('settings/document-updated', 'other' as never, 1)
    expect(spansOf(harness.entry().node)).toHaveLength(4)
    await harness.dispose()
  })

  it('rebinds to the exact selected Session and ignores a foreign Session\'s projection changes', async () => {
    resetSeq()
    const harness = await bootTodo({ todos: [item('a', 'in_progress')] })
    expect(fullText(harness.entry().summary)).toBe('● todo 0/1')
    // A write on another session is not this view's.
    const other = fakeAgent([])
    harness.projections.emit(other.session, [item('x', 'in_progress'), item('y', 'pending')])
    expect(fullText(harness.entry().summary)).toBe('● todo 0/1')
    harness.ctx.emit('test/session-changed', other as never)
    expect(fullText(harness.entry().summary)).toBe('● todo 0/2')
    harness.projections.emit(other.session, null)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('republishes when the language changes, and when the viewHistory setting is repeated unchanged it says nothing', async () => {
    resetSeq()
    const settings = { value: { viewHistory: false } as Record<string, unknown> }
    const harness = await bootTodo({ todos: [item('a', 'in_progress')], services: { mayflyInteractionState: { settingsSource: () => settings.value } } })
    await harness.ctx.plugin({ name: 'item-locale', apply(owner: Context) { const service = new MayflyLocaleService(owner, { systemLocale: 'en' }); owner.effect(() => () => service.dispose()) } })
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.entry().summary).not.toBeNull()
    const revision = harness.entry().revision
    harness.ctx.emit('settings/document-updated', 'mayfly' as never, 2)
    expect(harness.entry().revision).toBe(revision)
    await harness.dispose()
  })

  it('removes its view and its clock with its Fiber', async () => {
    resetSeq()
    const harness = await bootTodo({ todos: [item('a', 'in_progress')] })
    harness.write([item('a', 'completed')])
    expect(harness.tick.subscribers).toBe(1)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === todo.TODO_VIEW_ID)).toBe(false)
    expect(harness.tick.subscribers).toBe(0)
  })
})
