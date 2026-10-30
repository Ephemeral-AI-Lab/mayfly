/**
 * Panels for `/plugins` and `/update`: a read-only plugin inventory and the
 * release comparison. Both are plain nodes over the shared panel chrome.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/plugins
 */

import { panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Stable control and action ids for the plugin inventory. */
export const REMOTE_PLUGINS_LIST_ID = 'plugins-list'
export const REMOTE_PLUGINS_REFRESH_ID = 'plugins-refresh'
/** Stable action id for the update recheck. */
export const REMOTE_UPDATE_REFRESH_ID = 'update-refresh'

/** One plugin row as this frontend renders it. */
export interface RemotePluginRow {
  readonly name: string
  /** The module specifier the Loader entry imports. */
  readonly detail: string
  readonly state: string
  /** The entry's fiber phase, the closest fact this Host exposes to a version. */
  readonly kind: string
}

/** Plugin inventory state. */
export interface RemotePluginsState {
  readonly rows: readonly RemotePluginRow[]
  readonly error: string | undefined
}

/** Release comparison state; `facts` is absent until a check succeeds. */
export interface RemoteUpdateFacts {
  readonly current: string
  readonly latest: string
  readonly newer: boolean
}

/** Update-panel state. */
export interface RemoteUpdateState {
  readonly facts: RemoteUpdateFacts | undefined
  readonly error: string | undefined
}

function pluginItems(rows: readonly RemotePluginRow[]): readonly MayflyListItem[] {
  return rows.map((row, index) => ({
    id: `${String(index)}:${row.name}`,
    label: row.name,
    cells: [
      { spans: [{ text: row.kind === '' ? '' : ` ${row.kind}`, tone: 'muted' as const }], align: 'right' as const, min: 9, shed: 2 },
      { spans: [{ text: row.state, tone: row.state === 'disabled' ? 'warning' as const : 'success' as const }], min: 9, shed: 1 },
      { spans: [{ text: row.detail, tone: 'muted' as const }], align: 'right' as const, min: 1, shed: 3 },
    ],
    searchText: `${row.name} ${row.detail}`,
  }))
}

/** Build the read-only plugin inventory. */
export function remotePluginInventoryNode(state: RemotePluginsState, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Plugins'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      ui.list({
        id: REMOTE_PLUGINS_LIST_ID,
        role: 'browse',
        selectedIds: [],
        filterable: true,
        filterMode: 'slash',
        items: state.rows.length === 0 ? [] : pluginItems(state.rows),
        empty: ui.empty({ title: t('No plugins reported by this Host') }),
      }),
      ui.text(t('Only the Host may change its own plugins; this frontend never installs, removes, or upgrades them.'), { tone: 'muted', overflow: 'wrap' }),
      ui.actions({ id: 'plugins-actions', items: [{ id: REMOTE_PLUGINS_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}

/** Build the release comparison. */
export function remoteUpdateNode(state: RemoteUpdateState, t: MayflyTranslate): MayflyUiNode {
  const facts = state.facts
  const verdict = facts === undefined
    ? []
    : [ui.text(facts.newer
      ? t('A newer release is available; upgrade the Host profile to apply it.')
      : t('This build is the newest published release.'), { tone: facts.newer ? 'warning' : 'success', overflow: 'wrap' })]
  return panel({
    title: t('Update check'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      ui.fields([
        { label: t('Mayfly version'), value: [{ text: facts?.current ?? t('unavailable') }] },
        { label: t('Latest release'), value: [{ text: facts?.latest ?? t('unavailable') }] },
      ]),
      ...verdict,
      ui.text(t('Upgrades are never automatic: they change the Host profile and require a restart.'), { tone: 'muted', overflow: 'wrap' }),
      ui.actions({ id: 'update-actions', items: [{ id: REMOTE_UPDATE_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
