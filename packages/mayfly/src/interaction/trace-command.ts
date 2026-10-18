/** Native session trace observations, one shared panel, bounded documents, and explicit clipboard actions.
 * @module @ephemeral-ai/mayfly/interaction/trace-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { browser, panel, ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { copyTextToClipboard, type ClipboardCopyMethod } from './clipboard-write.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { formatTraceAll, formatTraceItem, traceTime, type TraceItem } from './trace-format.ts'
import { aggregateTraceItems } from './trace-aggregate.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

const ROOT = 'mayfly.trace'
/** The width from which the list and the JSON detail share the panel; below it they are pages. */
export const TRACE_BREAKPOINT = 100
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)
const sequence = (item: TraceItem) => item.lastSeq === item.seq ? `#${item.seq}` : `#${item.seq}-${item.lastSeq}`
const copiedVia = (method: ClipboardCopyMethod, t: MayflyTranslate) => method === 'osc52' ? t(' via terminal escape sequence (unverified)') : ''

/** Which page a narrow trace panel shows, and the item its detail describes. */
export interface TracePanelState {
  readonly selected?: TraceItem | undefined
  readonly document?: string | undefined
  readonly narrow?: 'list' | 'detail' | undefined
  readonly escapeLabel?: 'close' | 'back' | undefined
}

/** The JSON detail of one trace item: type and surface fields over the bounded highlighted document. */
export function traceDetailBody(item: TraceItem, document: string, t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return ui.stack.column([
    ui.fields([{ label: t('Type'), value: [{ text: item.type }] }, { label: t('Surface'), value: [{ text: item.surface }] }]),
    ui.child(ui.scroll(ui.code(document, { language: 'json' }), { id: 'trace-document', scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ui.actions({ id: 'trace-detail-actions', items: [{ id: 'copy', label: t('Copy trace item'), hintLabel: t('copy'), semantic: 'copy', hidden: true }] }),
  ])
}

/** The one trace panel: the event list and the selected item's JSON detail, split above the breakpoint and paged below it. */
export function tracePanelModel(sessionId: string, items: readonly TraceItem[], t: MayflyTranslate = interpolateLocaleMessage, state: TracePanelState = {}): MayflyUiNode {
  const list = ui.list({
    id: 'trace-events', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash',
    items: items.map(item => ({
      id: String(item.seq), label: item.title,
      cells: [
        { spans: [{ text: traceTime(item.time), tone: 'muted' }], min: 8 },
        { spans: [{ text: sequence(item), tone: 'muted' }], min: 6 },
        { spans: [{ text: item.surface, tone: 'muted' }], min: 8, shed: 1 },
      ],
      detail: item.summary.replaceAll(/\s+/g, ' ').trim().slice(0, 512),
      searchText: `${traceTime(item.time)} ${sequence(item)} ${item.title} ${item.type} ${item.surface} ${item.summary}`,
    })),
    empty: ui.empty({ title: t('no trace events yet') }),
  })
  const detail = state.selected === undefined
    ? ui.text(t('Trace detail'), { tone: 'muted' })
    : traceDetailBody(state.selected, state.document ?? '', t)
  return panel({
    title: `${t('Trace')} · ${sessionId}`,
    escapeLabel: state.escapeLabel ?? 'close',
    body: browser({ list, detail, narrow: state.narrow ?? 'list' }),
  })
}

/** The detail as its own panel; kept for direct publishing of one item. */
export function traceDetailPanelModel(item: TraceItem, document: string, t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return panel({ title: `${t('Trace detail')} ${sequence(item)}`, escapeLabel: 'back', body: traceDetailBody(item, document, t) })
}

/** The command consumer owns query work; each opened view has an exact-Agent child Fiber. */
export function registerTraceCommand(ctx: Context): () => void {
  const lifetime = new AbortController()
  const registry = ctx.mayflyOverlays
  const currentAgents = ctx.mayflyCurrentAgent
  const t = interactionTranslator(ctx)
  const current = (agent: Agent, signal: AbortSignal) => !signal.aborted && currentAgents.current() === agent
  const columns = (): number => ctx.get('mayflyScreen')?.columns ?? Number.POSITIVE_INFINITY

  async function open(rawInput: string, callerSignal: AbortSignal): Promise<CommandResult> {
    const signal = AbortSignal.any([lifetime.signal, callerSignal])
    const agent = currentAgents.current()
    if (agent === null) return { kind: 'error', text: t('no session is live yet') }
    if (!current(agent, signal)) return { kind: 'success' }
    const input = rawInput.trim()
    if (input === '' && registry.focus(ROOT)) return { kind: 'success' }
    const query = ctx.get('sessionQuery')
    if (query === undefined) return { kind: 'error', text: t('could not read trace: {error}', { error: t('session query is unavailable') }) }
    let events: readonly SessionEvent[]
    try { events = (await query.readSession(agent.id)).events }
    catch (error) { return current(agent, signal) ? { kind: 'error', text: t('could not read trace: {error}', { error: describe(error) }) } : { kind: 'success' } }
    if (!current(agent, signal)) return { kind: 'success' }
    const items = aggregateTraceItems(buildSessionEventRecords(agent.id, events), events)
    const eventBySeq = new Map<number, SessionEvent>(events.map(event => [event.seq, event]))
    const rawEvents = (item: TraceItem) => item.eventSeqs.map(seq => eventBySeq.get(seq)!)
    const copy = async (item: TraceItem | undefined, taskSignal: AbortSignal): Promise<CommandResult> => {
      try {
        const relation = item === undefined ? undefined : await query.traceEvent({ sessionId: agent.id, seq: SessionSeq(item.seq) }, taskSignal)
        if (!current(agent, taskSignal)) return { kind: 'success' }
        const text = item === undefined ? formatTraceAll(items, String(agent.id)) : formatTraceItem(item, undefined, relation, rawEvents(item))
        const method = await copyTextToClipboard(text)
        if (!current(agent, taskSignal)) return { kind: 'success' }
        return { kind: 'success', text: (item === undefined ? t('copied {count} trace events', { count: items.length }) : t('copied trace item #{seq}', { seq: item.seq })) + copiedVia(method, t) }
      } catch (error) {
        return current(agent, taskSignal) ? { kind: 'error', text: t('could not copy trace: {error}', { error: describe(error) }) } : { kind: 'success' }
      }
    }
    if (input === 'copy all') return copy(undefined, signal)
    if (input !== '') {
      const match = /^copy\s+(\d+)$/u.exec(input)
      if (match === null) return { kind: 'error', text: 'usage: /trace [copy <seq>|copy all]' }
      const item = items.find(item => item.seq === Number(match[1]))
      return item === undefined ? { kind: 'error', text: t('trace event #{seq} was not found', { seq: match[1]! }) } : copy(item, signal)
    }
    if (registry.focus(ROOT)) return { kind: 'success' }
    const copyReply = async (item: TraceItem | undefined, taskSignal: AbortSignal) => {
      const result = await copy(item, taskSignal)
      return result.kind === 'error' ? { kind: 'failed' as const, message: result.text }
        : { kind: 'completed' as const, ...result.text === undefined ? {} : { feedback: { severity: 'success' as const, message: result.text } } }
    }
    let selected: TraceItem | undefined
    let narrow: 'list' | 'detail' = 'list'
    let root: MayflyOverlayHandle | undefined
    const view = (): MayflyUiNode => tracePanelModel(String(agent.id), items, t, {
      selected,
      document: selected === undefined ? undefined : JSON.stringify(rawEvents(selected), null, 2),
      narrow,
      escapeLabel: narrow === 'detail' && columns() < TRACE_BREAKPOINT ? 'back' : 'close',
    })
    const publish = () => { if (root?.closed === false) root.set(view()) }
    root = await openAgentOverlay(ctx, agent, { id: ROOT, presentation: 'editor', capturing: true, dismissal: 'discard' }, view(), owner => {
      owner.effect(() => observeInteractionLocale(owner, publish))
      return async (event, context) => {
        if (event.kind === 'dismiss') {
          if (narrow === 'detail' && columns() < TRACE_BREAKPOINT) { narrow = 'list'; publish(); return { kind: 'completed', dismiss: false } }
          return { kind: 'completed' }
        }
        if (context.signal.aborted || !current(agent, context.signal)) return { kind: 'cancelled', dismiss: true }
        if (event.kind === 'activate' && event.actionId === 'copy-all') return copyReply(undefined, context.signal)
        if (event.kind === 'activate' && event.actionId === 'copy') return copyReply(selected, context.signal)
        if (event.kind !== 'selection-accept' || event.controlId !== 'trace-events') return { kind: 'completed' }
        const item = items.find(item => String(item.seq) === event.selectedIds[0])
        if (item === undefined) return { kind: 'completed' }
        selected = item
        if (columns() < TRACE_BREAKPOINT) narrow = 'detail'
        publish()
        return { kind: 'completed' }
      }
    }, { signal, reopen: 'focus' })
    return { kind: 'success' }
  }
  const command = ctx.commands.register({ name: 'trace', description: t('Browse and copy the current session execution trace'), input: { hint: '[copy <seq>|copy all]' }, handler: invocation => open(invocation.rawInput, invocation.signal) })
  return ctx.effect(() => () => { lifetime.abort(); command() })
}
