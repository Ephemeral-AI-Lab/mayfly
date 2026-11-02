/**
 * Release discovery panel over the shared panel chrome.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/plugins
 */

import { panel, ui, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Stable action id for the update recheck. */
export const REMOTE_UPDATE_REFRESH_ID = 'update-refresh'

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
