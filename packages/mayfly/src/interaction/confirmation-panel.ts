/** Explicit Yes/No confirmation using canonical actions and renderer-owned focus.
 * @module @ephemeral-ai/mayfly/interaction/confirmation-panel
 */

import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { CanonicalPanelAdapter, type CanonicalPanelAdapterOptions } from './canonical-panel.ts'

interface ConfirmationOptions extends Pick<CanonicalPanelAdapterOptions, 'components' | 'theme' | 'keymap'> {
  readonly title: string
  readonly question: string
  readonly detail?: string
  readonly t?: MayflyTranslate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** Create a one-shot confirmation with No initially focused and Escape cancelling. */
export function createConfirmationPanel(options: ConfirmationOptions): CanonicalPanelAdapter {
  const t = options.t ?? interpolateLocaleMessage
  let settled = false
  const finish = (confirmed: boolean): void => {
    if (settled) return
    settled = true
    if (confirmed) options.onConfirm()
    else options.onCancel()
  }
  const panel = new CanonicalPanelAdapter({
    ...options,
    node: (): MayflyUiNode => ({
      kind: 'surface', chrome: 'overlay', title: t(options.title),
      child: {
        kind: 'stack', direction: 'column', gap: 1,
        children: [
          { node: { kind: 'text', content: t(options.question) } },
          ...(options.detail === undefined ? [] : [{ node: { kind: 'text' as const, content: t(options.detail), tone: 'muted' as const } }]),
          { node: { kind: 'actions', id: 'confirmation', items: [
            { id: 'confirmation-yes', label: t('Yes'), intent: 'danger' },
            { id: 'confirmation-no', label: t('No'), intent: 'primary' },
          ] } },
        ],
      },
    }),
    onEvent: event => {
      if (event.kind !== 'activate') return
      if (event.controlId === 'confirmation-yes') finish(true)
      else if (event.controlId === 'confirmation-no') finish(false)
    },
    onUnhandledEscape: () => finish(false),
  })
  return panel
}
