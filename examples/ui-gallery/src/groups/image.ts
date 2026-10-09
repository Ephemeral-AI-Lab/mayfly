/**
 * Image demos: `ui.image` keeps an attachment inline. The wire carries only the attachment id and the `alt`
 * fallback, so a host tree without a loader for these ids (the gallery supplies none) shows the alt rows.
 *
 * @module @mayfly-example/ui-gallery/groups/image
 */
import { ui } from '@ephemeral-ai/mayfly-ui'

/** Image demos: the alt shows until a loader supplies the bytes and on terminals without an image protocol. */
export function imageGroup() {
  return [
    ui.divider({ label: 'Image' }),
    ui.image({ attachmentId: 'gallery-screenshot', alt: '[Image #1 84 KB]', maxRows: 12 }),
    ui.text('The alt text shows until the host tree supplies the bytes, and on terminals without an image protocol.', { tone: 'muted' }),
    ui.image({ attachmentId: 'gallery-diagram', alt: '[Image #2 12 KB 中文说明]' }),
  ]
}
