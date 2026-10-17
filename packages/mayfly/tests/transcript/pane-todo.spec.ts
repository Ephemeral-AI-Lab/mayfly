/**
 * The Todo item of the status row (`pane-todo`): its summary and panel as pure functions of the list, and the view that
 * follows the attached session's `todo/write` snapshots. Covers the unfinished summary (`● todo 2/12 4m 12s`) and the
 * time it gives up first, the closing item (`✓ todo 6/6 12s`) held five seconds, the fixed-length scrolling panel with no
 * heading or count, the `viewHistory` setting that lists finished rows, the interrupted line, a list that settled before
 * the session loaded, session changes, and the Fiber's cleanup.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import * as todo from '../../src/transcript/pane-todo.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { VIEW_PANEL_ROWS } from '../../src/transcript/view-items.ts'
import { event, resetSeq, turnEnd, turnStart } from './helpers.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'

/** A `todo/write` whole-list snapshot event. */
function todoWrite(todos: TodoItem[]): SessionEvent<'todo/write'> {
  return event('todo/write', { todos })
}

const item = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

/** The text of every rich-text span under a node, in order, and the spans themselves. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string, readonly styles?: readonly string[] }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  return [...record.kind === 'rich-text' ? record.spans as never[] : [], ...Object.entries(record).filter(([key]) => key !== 'spans').flatMap(([, value]) => spansOf(value))]
}
/** A summary's words at its full form. */
const fullText = (summary: { readonly node: unknown } | null | undefined): string => spansOf((summary!.node as { readonly node: unknown }).node).map(span => span.text).join('')

describe('todoSummary', () => {
  const t = transcriptTranslatorFake
  const state = (todos: TodoItem[], extra: Partial<todo.TodoState> = {}): todo.TodoState => ({ todos, interrupted: false, history: false, elapsedMs: 252_000, ...extra })

  it('has no summary for no list', () => {
    expect(todo.todoSummary(state([]), t)).toBeNull()
  })

  it('says the mark, done over total, and the time, with the time as the form the row gives up first', () => {
    const list = [...Array.from({ length: 2 }, (_, index) => item(`d${index}`, 'completed')), item('now', 'in_progress'), ...Array.from({ length: 9 }, (_, index) => item(`p${index}`, 'pending'))]
    const summary = todo.todoSummary(state(list), t)!
    expect(fullText(summary)).toBe('● todo 2/12 4m 12s')
    const shed = summary.node as unknown as { readonly kind: string, readonly narrower: readonly { readonly rank: number, readonly node: unknown }[] }
    expect(shed.kind).toBe('shed')
    expect(shed.narrower.map(form => [form.rank, spansOf(form.node).map(span => span.text).join('')])).toEqual([[SHED.time, '● todo 2/12']])
    expect(spansOf(summary.node)[0]).toEqual({ text: '●', tone: 'accent' })
  })

  it('closes with the success mark and the whole list once it settles', () => {
    const closing = todo.todoSummary(state([], { done: { total: 12, elapsedMs: 12_000 } }), t)!
    expect(fullText(closing)).toBe('✓ todo 12/12 12s')
    expect(spansOf(closing.node)[0]).toEqual({ text: '✓', tone: 'success' })
  })
})

describe('todoPanel', () => {
  const t = transcriptTranslatorFake
  const list = [item('first', 'completed'), item('now', 'in_progress'), item('next', 'pending')]
  const panel = (todos: TodoItem[], extra: Partial<todo.TodoState> = {}) => todo.todoPanel({ todos, interrupted: false, history: false, elapsedMs: 0, ...extra }, t)

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

async function bootTodo(initial: SessionEvent[] = [], services: Record<string, unknown> = {}) {
  const agent = fakeAgent(initial)
  const tick = new HandTick()
  const harness = await bootPanePlugin(todo, agent, { mayflyTick: tick, ...services })
  const entry = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === todo.TODO_VIEW_ID)!
  const write = (todos: TodoItem[]): void => { harness.ctx.emit('session/event', agent.session as unknown as Session, todoWrite(todos)) }
  return { ...harness, agent, tick, entry, write }
}

describe('mayfly-pane-todo', () => {
  it('registers a views pane at priority 14 that has no item until the first todo/write', async () => {
    resetSeq()
    const harness = await bootTodo()
    expect(harness.entry().definition).toMatchObject({ placement: 'views', priority: 14, title: 'Todo' })
    expect(harness.entry().summary).toBeNull()
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('reuses its rows when an unrelated delta carries the same todo projection', async () => {
    resetSeq()
    let reads = 0
    const tracked = [{ get content(): string { reads += 1; return 'a' }, get status(): TodoItem['status'] { reads += 1; return 'in_progress' } }]
    const harness = await bootTodo()
    harness.write(tracked)
    const revision = harness.entry().revision
    reads = 0
    harness.ctx.emit('session/event', harness.agent.session as unknown as Session, turnStart(2))
    expect(reads).toBe(0)
    expect(harness.entry().revision).toBe(revision)
    await harness.dispose()
  })

  it('shows done over total and the panel from the latest whole-list snapshot, and runs the clock only while a list is tracked', async () => {
    resetSeq()
    const harness = await bootTodo()
    harness.write([item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending')])
    expect(fullText(harness.entry().summary)).toMatch(/^● todo 1\/3/u)
    expect(harness.tick.subscribers).toBe(1)
    expect(spansOf(harness.entry().node).map(span => span.text)).toEqual(['  ● ', 'b', '  ○ ', 'c'])
    // The last write wins: a whole list replaces the one before it.
    harness.write([item('a', 'completed'), item('b', 'completed'), item('c', 'in_progress')])
    expect(fullText(harness.entry().summary)).toMatch(/^● todo 2\/3/u)
    // The time is measured from the first write of the list, by the shared tick.
    harness.tick.fire(Date.now() + 252_000)
    expect(fullText(harness.entry().summary)).toMatch(/^● todo 2\/3 4m 1[0-9]s$/u)
    await harness.dispose()
  })

  it('holds the closing item five seconds when a tracked list settles, then leaves with its clock', async () => {
    resetSeq()
    const harness = await bootTodo()
    harness.write([item('a', 'in_progress'), item('b', 'pending')])
    const before = Date.now()
    harness.write([item('a', 'completed'), item('b', 'completed')])
    const after = Date.now()
    expect(fullText(harness.entry().summary)).toMatch(/^✓ todo 2\/2 /u)
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(1)
    harness.tick.fire(before + todo.DONE_LINGER_MS - 1)
    expect(harness.entry().summary).not.toBeNull()
    harness.tick.fire(after + todo.DONE_LINGER_MS + 1_000)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    // The next list starts fresh.
    harness.write([item('c', 'pending')])
    expect(fullText(harness.entry().summary)).toMatch(/^● todo 0\/1/u)
    await harness.dispose()
  })

  it('shows nothing for a snapshot that already settled when the session loaded', async () => {
    resetSeq()
    const harness = await bootTodo([todoWrite([item('a', 'completed'), item('b', 'completed')])])
    expect(harness.entry().summary).toBeNull()
    expect(harness.entry().node).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('marks the panel interrupted when the run failed or was stopped with the list unfinished', async () => {
    resetSeq()
    const harness = await bootTodo([turnStart(1), todoWrite([item('a', 'in_progress')])])
    expect(JSON.stringify(harness.entry().node)).not.toContain('interrupted')
    harness.ctx.emit('session/event', harness.agent.session as unknown as Session, turnEnd(1, { kind: 'failed' } as never))
    expect(JSON.stringify(harness.entry().node)).toContain('"content":"  interrupted"')
    await harness.dispose()
  })

  it('lists finished rows only when the viewHistory setting is on, and follows the setting live', async () => {
    resetSeq()
    const settings = { value: { viewHistory: false } as Record<string, unknown> }
    const harness = await bootTodo([], { mayflyInteractionState: { settingsSource: () => settings.value } })
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

  it('clears the list when the session changes, and answers only its own session\'s writes', async () => {
    resetSeq()
    const harness = await bootTodo([todoWrite([item('a', 'in_progress')])])
    expect(harness.entry().summary).not.toBeNull()
    // A write on another session is not this view's.
    const other = fakeAgent([])
    harness.ctx.emit('session/event', other.session as unknown as Session, todoWrite([item('x', 'in_progress'), item('y', 'pending')]))
    expect(fullText(harness.entry().summary)).toMatch(/^● todo 0\/1/u)
    harness.ctx.emit('test/session-changed', other as never)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('republishes when the language changes, and when the viewHistory setting is repeated unchanged it says nothing', async () => {
    resetSeq()
    const settings = { value: { viewHistory: false } as Record<string, unknown> }
    const harness = await bootTodo([todoWrite([item('a', 'in_progress')])], { mayflyInteractionState: { settingsSource: () => settings.value } })
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
    const harness = await bootTodo([todoWrite([item('a', 'in_progress')])])
    expect(harness.tick.subscribers).toBe(1)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === todo.TODO_VIEW_ID)).toBe(false)
    expect(harness.tick.subscribers).toBe(0)
  })
})
