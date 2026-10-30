/**
 * Panels for `/provider`: the switchable provider roster and one provider's
 * model picker. Both are plain nodes over the shared panel chrome; neither
 * writes configuration or credentials.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/providers
 */

import { panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Stable control and action ids for the provider roster. */
export const REMOTE_PROVIDERS_LIST_ID = 'providers-list'
export const REMOTE_PROVIDERS_REFRESH_ID = 'providers-refresh'
/** Stable control and action ids for one provider's model picker. */
export const REMOTE_PROVIDER_MODELS_LIST_ID = 'provider-models-list'
export const REMOTE_PROVIDER_MODELS_REFRESH_ID = 'provider-models-refresh'

/** One provider row as this frontend renders it. */
export interface RemoteProviderRow {
  /** The provider route key a model selection names. */
  readonly id: string
  readonly name: string
  /** Whether the Host's adapter currently registers this route. */
  readonly live: boolean
  /** Catalog models this route offers; zero when the Host reported none. */
  readonly models: number
  /** Whether the current model selection already names this route. */
  readonly current: boolean
  /** Adapter-declared detail, such as an activation error or an OAuth hint. */
  readonly detail?: string
}

/** Provider roster state. */
export interface RemoteProvidersState {
  readonly rows: readonly RemoteProviderRow[]
  readonly error: string | undefined
}

/** One selectable model of the provider being switched to. */
export interface RemoteProviderModelRow {
  readonly id: string
  readonly label: string
  readonly current: boolean
  /** Context window from the Host's merged catalog details. */
  readonly detail?: string
}

/** One provider's model picker state. */
export interface RemoteProviderModelsState {
  readonly provider: string
  readonly providerLabel: string
  readonly rows: readonly RemoteProviderModelRow[]
  readonly error: string | undefined
  /** Why the roster is empty, when it is. */
  readonly note: string | undefined
}

function providerItems(rows: readonly RemoteProviderRow[], t: MayflyTranslate): readonly MayflyListItem[] {
  return rows.map(row => ({
    id: row.id,
    label: row.name,
    cells: [
      // A leading space keeps the state off the label: the list's own cell gap
      // is only inserted after a painted cell, and the label column carries no
      // width of its own.
      { spans: [{ text: ` ${row.live ? t('live') : t('dormant')}`, tone: row.live ? 'success' as const : 'muted' as const }], min: 8, shed: 1 },
      {
        spans: [{ text: row.models === 0 ? t('no models') : t('{count} models', { count: row.models }), tone: 'muted' as const }],
        align: 'right' as const,
        min: 9,
        shed: 2,
      },
    ],
    ...row.detail === undefined ? {} : { detail: row.detail },
    ...row.current ? { current: true } : {},
    searchText: `${row.name} ${row.id}`,
  }))
}

function modelItems(rows: readonly RemoteProviderModelRow[]): readonly MayflyListItem[] {
  return rows.map(row => ({
    id: row.id,
    label: row.label,
    ...row.detail === undefined ? {} : { detail: row.detail },
    ...row.current ? { current: true } : {},
  }))
}

/** Build the switchable provider roster. */
export function remoteProviderListPanelNode(state: RemoteProvidersState, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Providers'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      ui.list({
        id: REMOTE_PROVIDERS_LIST_ID,
        role: 'browse',
        selectedIds: [],
        filterable: true,
        filterMode: 'slash',
        items: providerItems(state.rows, t),
        empty: ui.empty({ title: t('No providers reported by this Host') }),
      }),
      ui.text(t('Choosing a provider picks one of its models; the Host keeps the credentials.'), { tone: 'muted', overflow: 'wrap' }),
      ui.actions({ id: 'providers-actions', items: [{ id: REMOTE_PROVIDERS_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}

/** Build one provider's model picker. */
export function remoteProviderModelsPanelNode(state: RemoteProviderModelsState, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Models for {provider}', { provider: state.providerLabel }),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
      ...state.note === undefined ? [] : [ui.text(state.note, { tone: 'muted', overflow: 'wrap' })],
      ui.list({
        id: REMOTE_PROVIDER_MODELS_LIST_ID,
        role: 'browse',
        selectedIds: [],
        filterable: true,
        filterMode: 'slash',
        items: modelItems(state.rows),
        empty: ui.empty({ title: t('This provider offers no models') }),
      }),
      ui.text(t('Switching the provider selects one of its models for this session or for new ones.'), { tone: 'muted', overflow: 'wrap' }),
      ui.actions({ id: 'provider-models-actions', items: [{ id: REMOTE_PROVIDER_MODELS_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
