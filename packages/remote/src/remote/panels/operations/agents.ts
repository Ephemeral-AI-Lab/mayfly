/**
 * Current Session descendant tree rows and the cold/continuable child detail view.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/agents
 */

import { browser, panel, ui, type MayflyInlineSpan, type MayflyListItem, type MayflyTone, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** List control id shared by the agents browser pages. */
export const REMOTE_AGENTS_LIST_ID = 'agents-list'
/** Stop action id; drains one continuable live direct child. */
export const REMOTE_AGENTS_STOP_ID = 'agents-stop'
/** Open action id; presents one cold read-only child view. */
export const REMOTE_AGENTS_OPEN_ID = 'agents-open'
/** Prompt action id; queues or steers one continuable direct child. */
export const REMOTE_AGENTS_PROMPT_ID = 'agents-prompt'
/** Refresh action id for the tree snapshot. */
export const REMOTE_AGENTS_REFRESH_ID = 'agents-refresh'

/** Addressing mode of one descendant, read from its official subagent address. */
export type RemoteAgentMode = 'one-shot' | 'continuable' | 'unknown'

/** One descendant tree row; no Agent is loaded to display it. */
export interface RemoteAgentRow {
  readonly id: SessionId
  readonly parent: SessionId
  readonly depth: number
  readonly label: string
  readonly mode: RemoteAgentMode
  readonly running: boolean
  readonly stopping: boolean
}

/** Tree browser state: rows, the focused row, and the snapshot failure. */
export interface RemoteAgentsState {
  readonly rows: readonly RemoteAgentRow[]
  readonly selectedId: SessionId | undefined
  readonly error: string | undefined
}

const MODE_TONE: Readonly<Record<RemoteAgentMode, MayflyTone>> = {
  continuable: 'accent', 'one-shot': 'muted', unknown: 'muted',
}

function item(row: RemoteAgentRow): MayflyListItem {
  const mark: MayflyInlineSpan = row.stopping ? { text: '⊘', tone: 'muted' } : row.running ? { text: '●', tone: 'accent' } : { text: '○', tone: 'muted' }
  return {
    id: row.id,
    label: `${'  '.repeat(row.depth)}${row.label}`,
    labelSpans: [mark, { text: ' ' }],
    cells: [{ spans: [{ text: row.mode, tone: MODE_TONE[row.mode] }] }],
    searchText: `${row.label} ${row.id}`,
  }
}

function detail(row: RemoteAgentRow, t: MayflyTranslate): MayflyUiNode {
  const stoppable = row.mode === 'continuable' && row.running && !row.stopping
  const promptable = row.mode === 'continuable'
  return panel({
    title: t('Subagent'),
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.fields([
        { label: t('Label'), value: [{ text: row.label }] },
        { label: t('Mode'), value: [{ text: row.mode, tone: MODE_TONE[row.mode] }] },
        { label: t('Running'), value: [{ text: row.stopping ? t('stopping') : row.running ? t('live') : t('idle'), tone: row.running && !row.stopping ? 'success' : 'muted' }] },
        { label: t('Session'), value: [{ text: row.id, tone: 'muted' }] },
        { label: t('Parent'), value: [{ text: row.parent, tone: 'muted' }] },
      ]),
      ui.actions({
        id: 'agents-detail-actions',
        items: [
          ...stoppable ? [{
            id: REMOTE_AGENTS_STOP_ID,
            label: t('stop'),
            semantic: 'delete' as const,
            hintLabel: t('stop'),
            confirm: { title: t('Stop this subagent?'), detail: t('The child is drained through its exact parent and then counts as stopped.'), confirmLabel: t('Stop'), tone: 'danger' as const },
          }] : [],
          { id: REMOTE_AGENTS_OPEN_ID, label: t('open'), hintLabel: t('open') },
          ...promptable ? [{ id: REMOTE_AGENTS_PROMPT_ID, label: t('prompt'), hintLabel: t('prompt') }] : [],
        ],
      }),
    ]),
  })
}

/** Build the descendant tree browser with a live detail page and refresh. */
export function remoteAgentsPanel(state: RemoteAgentsState, t: MayflyTranslate): MayflyUiNode {
  const rows = state.rows
  const selected = state.selectedId === undefined ? undefined : rows.find(row => row.id === state.selectedId)
  const list = (id: string): MayflyUiNode => ui.list({
    id,
    role: 'browse',
    selectedIds: state.selectedId === undefined ? [] : [state.selectedId],
    items: rows.map(item),
    empty: ui.empty({ title: t('No subagent descendants') }),
  })
  return panel({
    title: t('Subagents'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      browser({
        list: list(REMOTE_AGENTS_LIST_ID),
        listNarrow: list('agents-list-narrow'),
        detail: selected === undefined ? ui.text(t('Select a subagent to see its actions'), { tone: 'muted' }) : detail(selected, t),
        narrow: 'list',
      }),
      ui.actions({ id: 'agents-actions', items: [{ id: REMOTE_AGENTS_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
