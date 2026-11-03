/**
 * The painter behind `image` nodes: the unified loader row while the host tree's loader reads the bytes, the node's
 * `alt` when it has none or the terminal has no image protocol, then the existing `createImage` component. The painter owns no bytes; it asks the
 * surface's image source, which shares one load per attachment across every surface.
 *
 * @module @ephemeral-ai/mayfly/core/ui-image
 */
import type { MayflyImageNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyImage, MayflyComponents, MayflySemanticColors } from './types.ts'
import type { MayflyUiImageBytes, MayflyUiImageSource } from './ui-images.ts'

/** Paints one `image` node; one painter per compiled node. */
export class UiImagePainter {
  private image: { readonly bytes: MayflyUiImageBytes, readonly component: MayflyImage } | undefined

  /**
   * @param node - the admitted node.
   * @param components - the factory that creates the image component and measures text.
   * @param colors - the semantic palette the alt text is painted from.
   * @param source - the host tree's byte source; absent outside a frontend tree, where the alt is all there is.
   * @param repaint - asks the surface to paint again when the bytes arrive.
   * @param pending - the loader row painted while the bytes are read (the compiler's, so it moves with the one clock).
   */
  constructor(
    private readonly node: MayflyImageNode,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly source: MayflyUiImageSource | undefined,
    private readonly repaint: () => void,
    private readonly pending: (width: number) => string[],
  ) {}

  /** The rows at `width`: the loader while the bytes come, the image when they are here and the terminal draws it, else one muted alt row. */
  render(width: number): string[] {
    const available = Math.max(1, width)
    const read = this.source?.read(this.node.attachmentId, this.repaint)
    if (read?.state === 'pending') return this.pending(available)
    if (read?.state === 'ready' && this.components.imageProtocol()) {
      if (this.image?.bytes !== read.image) {
        this.image = {
          bytes: read.image,
          component: this.components.createImage({
            data: read.image.data,
            mediaType: read.image.mediaType,
            ...(read.image.name === undefined ? {} : { filename: read.image.name }),
            ...(this.node.maxRows === undefined ? {} : { maxHeightCells: this.node.maxRows }),
          }),
        }
      }
      return this.image.component.render(available)
    }
    return [this.components.truncateToWidth(this.colors.textMuted(this.node.alt.replace(/\s+/gu, ' ')), available)]
  }

  /** Drop the image's own row cache; the next render rebuilds from the bytes. */
  invalidate(): void {
    this.image?.component.invalidate()
  }
}
