/** The reference session-title editor over the owner's current title. @module */
import { panel, ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

/** One prefilled title field with the reference read-and-rename action. */
export function renamePanelModel(title: string, t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return panel({
    title: t('Rename session'),
    escapeLabel: 'cancel',
    body: ui.form({ id: 'session-rename', enterSubmits: 'save', fields: [{ kind: 'input', id: 'title', label: t('Session name'), value: title }] }),
    footer: ui.actions({ id: 'rename-actions', items: [
      { id: 'save', label: t('Rename'), hintLabel: t('rename'), hidden: true, read: [{ pagePath: [], formId: 'session-rename' }] },
    ] }),
  })
}
