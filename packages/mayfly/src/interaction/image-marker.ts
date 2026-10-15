/**
 * The text a pasted image leaves in the editor buffer: `[image #N 84 KB]`, a serial number and the size. The marker is
 * the key of the tree's marker-to-attachment map; the submit transformer splits the submitted line on the markers the
 * map knows, and the editor shows each as a token.
 *
 * @module @ephemeral-ai/mayfly/interaction/image-marker
 */

/** Every marker shape in a text: global, so each call site takes its own matches. */
export const IMAGE_MARKER = /\[image #\d+ [^\]]+\]/gu

/**
 * A byte count as the marker writes it: `512 B`, `84 KB`, `1.5 MB`.
 * @param bytes - the size of the encoded image.
 * @returns the size text.
 */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The marker of one pasted image.
 * @param serial - the tree's running image number.
 * @param bytes - the size of the encoded image.
 * @returns the marker text.
 */
export function imageMarker(serial: number, bytes: number): string {
  return `[image #${String(serial)} ${formatImageSize(bytes)}]`
}
