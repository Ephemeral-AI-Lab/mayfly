/** Reference trace timeline, responsive detail and clipboard documents over readonly native facts.
 * @module @ephemeral-ai/mayfly/interaction/trace-model
 */
import { browser, panel, ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

/** One display-ready event in the trace timeline. */
export interface TraceItem {
  readonly seq: number
  readonly lastSeq: number
  readonly eventSeqs: readonly number[]
  readonly time: number
  readonly type: string
  readonly surface: 'current' | 'shadowed' | 'log-only'
  readonly title: string
  readonly summary: string
}

/** Native direct event relationships used by the clipboard document. */
interface TraceRelation {
  readonly replacedBy?: number
  readonly replacementChain: readonly number[]
  readonly replacedEventSeqs: readonly number[]
  readonly sourceEventSeqs: readonly number[]
  readonly derivedEventSeqs: readonly number[]
}

/** The width from which the list and the JSON detail share the panel; below it they are pages. */
export const TRACE_BREAKPOINT = 100
const sequence = (item: TraceItem) => item.lastSeq === item.seq ? `#${item.seq}` : `#${item.seq}-${item.lastSeq}`

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

/** Format a timestamp consistently across the panel and clipboard output. */
export function traceTime(time: number): string {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 19) : '??:??:??'
}

/** Serialize one event and its official relationship trace for clipboard use. */
export function formatTraceItem(item: TraceItem, window: { readonly target: unknown } | undefined, relation: TraceRelation | undefined, rawEvents: readonly unknown[] = []): string {
  const sequence = item.lastSeq === item.seq ? `#${String(item.seq)}` : `#${String(item.seq)}-${String(item.lastSeq)}`
  const lines = [`[${traceTime(item.time)}] ${sequence} ${item.title} (${item.type})`, `surface: ${item.surface}`]
  if (item.summary.length > 0) lines.push('', item.summary)
  if (relation !== undefined) {
    if (relation.replacedBy !== undefined) lines.push('', `replaced by: #${String(relation.replacedBy)}`)
    if (relation.replacementChain.length > 0) lines.push(`replacement chain: ${relation.replacementChain.map(seq => `#${String(seq)}`).join(' -> ')}`)
    if (relation.replacedEventSeqs.length > 0) lines.push(`replaces: ${relation.replacedEventSeqs.map(seq => `#${String(seq)}`).join(', ')}`)
    if (relation.sourceEventSeqs.length > 0) lines.push(`sources: ${relation.sourceEventSeqs.map(seq => `#${String(seq)}`).join(', ')}`)
    if (relation.derivedEventSeqs.length > 0) lines.push(`derived: ${relation.derivedEventSeqs.map(seq => `#${String(seq)}`).join(', ')}`)
  }
  if (window !== undefined) {
    lines.push('', 'raw event:', JSON.stringify(window.target, null, 2))
  } else if (rawEvents.length > 0) {
    lines.push('', 'raw events:', JSON.stringify(rawEvents, null, 2))
  }
  return lines.join('\n')
}

/** Serialize the complete timeline as stable Markdown for clipboard use. */
export function formatTraceAll(items: readonly TraceItem[], sessionId: string): string {
  const lines = [`# Trace`, '', `Session: ${sessionId}`, '']
  for (const item of items) {
    const sequence = item.lastSeq === item.seq ? `#${String(item.seq)}` : `#${String(item.seq)}-${String(item.lastSeq)}`
    lines.push(`## [${traceTime(item.time)}] ${sequence} ${item.title}`, '', `Type: ${item.type}`, `Surface: ${item.surface}`)
    if (item.summary.length > 0) lines.push('', item.summary)
    lines.push('')
  }
  return lines.join('\n')
}

