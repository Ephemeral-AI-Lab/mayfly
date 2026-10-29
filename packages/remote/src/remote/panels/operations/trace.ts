/**
 * Recent session event rows with a secret-free JSON detail view and copy action.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/trace
 */

import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { browser, panel, ui, type MayflyListItem, type MayflyTone, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Event list control id shared by the trace browser pages. */
export const REMOTE_TRACE_LIST_ID = 'trace-events'
/** Copy action id for the selected event's JSON detail. */
export const REMOTE_TRACE_COPY_ID = 'trace-copy'
/** Refresh action id for the trace read. */
export const REMOTE_TRACE_REFRESH_ID = 'trace-refresh'

/** One displayed trace row: the event plus its derived one-line summary. */
export interface RemoteTraceRow {
  readonly event: SessionWireEvent
  readonly summary: string
}

/** Trace browser state: rows, the focused event JSON, and the read failure. */
export interface RemoteTraceState {
  readonly rows: readonly RemoteTraceRow[]
  readonly selectedId: string | undefined
  readonly detail: string | undefined
  readonly canCopy: boolean
  readonly error: string | undefined
}

function toneOf(event: SessionWireEvent): MayflyTone {
  if (event.type === 'turn/end' || event.type === 'tool/result') return 'muted'
  if (event.type === 'user/message') return 'primary'
  return 'default'
}

function row(item: RemoteTraceRow): MayflyListItem {
  return {
    id: String(item.event.seq),
    label: `${String(item.event.seq)} ${item.event.type}`,
    labelSpans: [{ text: String(item.event.seq), tone: toneOf(item.event) }, { text: ' ' }, { text: item.event.type }],
    cells: [{ spans: [{ text: item.summary, tone: 'muted' }], max: 60, shed: 1 }],
    searchText: `${item.event.type} ${item.summary}`,
  }
}

/** Build the recent-event trace browser with its JSON detail page. */
export function remoteTracePanel(state: RemoteTraceState, t: MayflyTranslate): MayflyUiNode {
  const list = (id: string): MayflyUiNode => ui.list({
    id,
    role: 'browse',
    selectedIds: state.selectedId === undefined ? [] : [state.selectedId],
    items: state.rows.map(item => row(item)),
    filterable: true,
    filterMode: 'slash',
    empty: ui.empty({ title: state.error ?? t('No session events') }),
  })
  return panel({
    title: t('Session trace'),
    escapeLabel: 'close',
    body: ui.stack.column([
      browser({
        list: list(REMOTE_TRACE_LIST_ID),
        listNarrow: list('trace-events-narrow'),
        detail: state.detail === undefined
          ? ui.text(t('Select an event to inspect its JSON'), { tone: 'muted' })
          : ui.code(state.detail, { language: 'json' }),
        narrow: 'list',
      }),
      ui.actions({
        id: 'trace-actions',
        items: [
          ...state.canCopy ? [{ id: REMOTE_TRACE_COPY_ID, label: t('copy'), semantic: 'copy' as const, hintLabel: t('copy') }] : [],
          { id: REMOTE_TRACE_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true },
        ],
      }),
    ]),
  })
}
