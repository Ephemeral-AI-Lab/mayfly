/** Native session trace observations, bounded documents, and explicit clipboard actions.
 * @module @ephemeral-ai/mayfly/interaction/trace-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { copyTextToClipboard, type ClipboardCopyMethod } from './clipboard-write.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { documentPages } from './document-pages.ts'
import { formatTraceAll, formatTraceItem, traceTime, type TraceItem } from './trace-format.ts'
import { aggregateTraceItems } from './trace-aggregate.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

const ROOT = 'mayfly.trace'
const PAGE = { pagePath: [], formId: 'trace-page' } as const
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)
const sequence = (item: TraceItem) => item.lastSeq === item.seq ? `#${item.seq}` : `#${item.seq}-${item.lastSeq}`
const copiedVia = (method: ClipboardCopyMethod, t: MayflyTranslate) => method === 'osc52' ? t(' via terminal escape sequence (unverified)') : ''

export function tracePanelModel(sessionId: string, items: readonly TraceItem[], t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return ui.surface({ title: `${t('Trace')} · ${sessionId}`, chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.list({ id: 'trace-events', role: 'browse', selectedIds: [], filterable: true, items: items.map(item => ({
      id: String(item.seq), label: `${traceTime(item.time)} ${sequence(item)} ${item.title}`,
      detail: item.summary.replaceAll(/\s+/g, ' ').trim().slice(0, 512), badge: item.surface,
    })), empty: ui.empty({ title: t('no trace events yet') }) }),
    ui.actions({ id: 'trace-actions', items: [{ id: 'copy-all', label: t('Copy all') }, { id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

export function traceDetailPanelModel(item: TraceItem, pages: readonly string[], page = 1, t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return ui.surface({ title: `${t('Trace detail')} ${sequence(item)}`, chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.fields([{ label: t('Type'), value: [{ text: item.type }] }, { label: t('Surface'), value: [{ text: item.surface }] }]),
    ui.child(ui.scroll(ui.code(pages[page - 1]!, { language: 'json' }), { id: `trace-document/${String(page)}`, scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ...pages.length === 1 ? [] : [
      ui.form({ id: PAGE.formId, fields: [{ kind: 'number', id: 'page', label: t('Page'), value: page, min: 1, max: pages.length, step: 1, required: true }] }),
      ui.actions({ id: 'page-actions', items: [
        { id: 'previous', label: t('Previous'), submit: [PAGE], disabled: page === 1 },
        { id: 'go', label: t('Go to page'), submit: [PAGE] },
        { id: 'next', label: t('Next page'), submit: [PAGE], disabled: page === pages.length },
      ] }),
    ],
    ui.actions({ id: 'trace-detail-actions', items: [{ id: 'copy', label: t('Copy trace item') }, { id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

/** The command consumer owns query work; each opened view has an exact-Agent child Fiber. */
export function registerTraceCommand(ctx: Context): () => void {
  const lifetime = new AbortController()
  const registry = ctx.mayflyOverlays
  const currentAgents = ctx.mayflyCurrentAgent
  const t = interactionTranslator(ctx)
  const current = (agent: Agent, signal: AbortSignal) => !signal.aborted && currentAgents.current() === agent

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
    let root: MayflyOverlayHandle | undefined
    root = await openAgentOverlay(ctx, agent, { id: ROOT, presentation: 'editor', capturing: true, dismissal: 'discard' }, tracePanelModel(String(agent.id), items, t), owner => {
      owner.effect(() => observeInteractionLocale(owner, () => { if (root?.closed === false) root.set(tracePanelModel(String(agent.id), items, t)) }))
      return async (event, context) => {
        if (event.kind === 'activate' && event.actionId === 'copy-all') return copyReply(undefined, context.signal)
        if (event.kind !== 'selection-accept' || event.controlId !== 'trace-events') return { kind: 'completed' }
        const item = items.find(item => String(item.seq) === event.selectedIds[0])
        if (item === undefined || context.signal.aborted) return { kind: 'completed' }
        const id = `${ROOT}.detail`
        registry.close(id)
        const pages = documentPages(JSON.stringify(rawEvents(item), null, 2))
        let detail: MayflyOverlayHandle | undefined
        let page = 1
        detail = await openAgentOverlay(owner, agent, { id, presentation: 'editor', capturing: true, dismissal: 'discard' }, traceDetailPanelModel(item, pages, page, t), scope => {
          scope.effect(() => observeInteractionLocale(scope, () => {
            if (detail?.closed !== false) return
            detail.set(traceDetailPanelModel(item, pages, page, t))
          }))
          return async (event, context) => {
            if (event.kind === 'activate' && event.actionId === 'copy') return copyReply(item, context.signal)
            if (event.kind !== 'submit') return { kind: 'completed' }
            const submittedPage = event.submission.forms.find(form => form.formId === PAGE.formId)?.fields.find(field => field.id === 'page')?.value
            if (typeof submittedPage !== 'number' || !Number.isInteger(submittedPage)) return { kind: 'failed', message: t('Invalid page') }
            const action = event.submission.actionId
            const target = action === 'previous' ? submittedPage - 1 : action === 'next' ? submittedPage + 1 : submittedPage
            page = Math.max(1, Math.min(pages.length, target))
            return { kind: 'accepted', node: traceDetailPanelModel(item, pages, page, t), source: [] }
          }
        }, signal)
        return { kind: 'completed' }
      }
    }, signal)
    return { kind: 'success' }
  }
  const command = ctx.commands.register({ name: 'trace', description: t('Browse and copy the current session execution trace'), input: { hint: '[copy <seq>|copy all]' }, handler: invocation => open(invocation.rawInput, invocation.signal) })
  return ctx.effect(() => () => { lifetime.abort(); command() })
}
