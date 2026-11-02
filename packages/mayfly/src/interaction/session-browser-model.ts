/** Pure workspace rail, session catalog, search, and details shared by both frontends. @module */
import { panel, rail, ui, type MayflyListItem, type MayflyTabItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { sessionDetailNode, sessionLabel, type SessionListFacts } from './session-list-model.ts'

/** Readonly presentation facts; the native Session and Workspace services own their catalogs. */
export interface SessionBrowserFacts {
  readonly title: string
  readonly tabs: readonly MayflyTabItem[]
  readonly activeTab: string
  readonly items: readonly MayflyListItem[]
  readonly now: number
  readonly globalSearch: boolean
  readonly awaitingSearch: boolean
  readonly busy: boolean
  readonly loading: boolean
  readonly message: string
  readonly detail?: {
    readonly facts: SessionListFacts
    readonly notice: string
    readonly activity: string
  }
}

/** The exact rc.2 editor panel, including its shared form admission and action confirmations. */
export function SessionBrowser(facts: SessionBrowserFacts, t: MayflyTranslate): MayflyUiNode {
  const detail = facts.detail
  const listPage = (): MayflyUiNode => ui.stack.column([
    ...(facts.message === '' ? [] : [ui.text(facts.message, { tone: 'warning' })]),
    ...(facts.loading ? [ui.loader({ message: t('Loading workspace sessions…') })] : []),
    ui.form({ id: 'content-search', enterSubmits: 'search', ...(facts.globalSearch ? { autofocus: true } : {}), fields: [{ kind: 'input', id: 'query', label: t(facts.globalSearch ? 'Search all conversation contents' : 'Search this workspace’s conversations'), maxLength: 500, value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: facts.awaitingSearch, filterable: true, filterMode: 'slash', selectedIds: [], autofocus: !facts.globalSearch, items: facts.items, empty: ui.empty({ title: t(facts.busy ? 'Waiting for sessions…' : facts.globalSearch && facts.awaitingSearch ? 'Enter text to search all workspaces' : 'No sessions') }) }),
    ui.actions({ id: 'session-actions', items: [
      { id: 'search', label: 'Search contents', hintLabel: 'search', hidden: true, disabled: facts.busy, read: [{ pagePath: [], formId: 'content-search' }] },
      { id: 'refresh', label: t('All sessions'), hintLabel: t('all sessions'), key: 'a', hidden: true, disabled: facts.busy },
      { id: 'reload', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true, disabled: facts.busy },
      { id: 'search-all', label: t('Search all contents'), hintLabel: t('search all'), semantic: 'search', hidden: true, disabled: facts.busy },
    ] }),
  ])
  const detailPage = (current: NonNullable<SessionBrowserFacts['detail']>): MayflyUiNode => ui.stack.column([
    sessionDetailNode(current.facts, facts.now, t),
    ...(current.notice === '' ? [] : [ui.text(current.notice, { tone: 'warning' })]),
    ...(current.activity === '' ? [] : [ui.text(current.activity, { tone: 'warning' })]),
    ui.actions({ id: 'session-detail-actions', items: [
      { id: 'open', label: 'Open conversation', hintLabel: 'open', key: 'o', hidden: true, disabled: current.facts.archived, ...(current.facts.archived ? { disabledReason: 'Restore the session first' } : {}) },
      { id: current.facts.archived ? 'restore' : 'archive', label: current.facts.archived ? 'Restore' : 'Archive', hintLabel: current.facts.archived ? 'restore' : 'archive', key: 'a', hidden: true, confirm: current.facts.archived ? 'Restore this session?' : 'Archive this session?' },
      ...(current.activity === '' ? [] : [{ id: 'stop-archive', label: 'Stop activity and archive', hintLabel: 'stop and archive', key: 's', hidden: true, intent: 'danger' as const, confirm: { title: 'Stop this session’s activity and archive it?', detail: current.activity, confirmLabel: 'Stop and archive', tone: 'danger' as const } }]),
    ] }),
  ])
  return panel({
    title: detail === undefined ? facts.title : sessionLabel(detail.facts, t),
    escapeLabel: detail === undefined ? 'close' : 'back',
    body: rail({
      rail: { id: 'session-rail', activeId: facts.activeTab, items: facts.tabs, hintLabel: t('workspaces') },
      content: detail === undefined ? listPage() : detailPage(detail),
    }),
  })
}
