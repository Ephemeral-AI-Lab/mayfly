/**
 * Named actions (roadmap slice 1.7): row keys that declare a common meaning or a component action instead of a fixed
 * key, scoped to the list they act on. A user who rebinds `ui.copy` or `ui-gallery.pin` moves the key and its hint.
 *
 * @module @mayfly-example/ui-gallery/groups/1-7
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

/** A browse list whose rows answer copy, refresh, and a gallery-owned pin action while the list has focus. */
export function namedActionsGroup() {
  return [
    ui.divider({ label: 'Named actions' }),
    ui.text('While the list has focus, c copies, r refreshes, and p pins: copy and refresh are the shared ui.copy and ui.refresh, pin is ui-gallery.pin.', { tone: 'muted' }),
    ui.list({
      id: 'gallery-keyed-list',
      role: 'browse',
      selectedIds: [],
      items: [
        { id: 'gallery-keyed-alpha', label: 'alpha.ts', detail: 'src/' },
        { id: 'gallery-keyed-beta', label: 'beta.ts', detail: 'src/' },
      ],
    }),
    ui.actions({
      id: 'gallery-keyed-actions',
      scope: 'gallery-keyed-list',
      items: [
        { id: 'gallery-keyed-copy', label: 'Copy', semantic: 'copy', hidden: true },
        { id: 'gallery-keyed-refresh', label: 'Refresh', semantic: 'refresh', hidden: true },
        { id: 'gallery-keyed-pin', label: 'Pin', action: 'ui-gallery.pin', key: 'p', hidden: true, hintLabel: 'pin' },
      ],
    }),
  ]
}
