/** The standalone editor uses the canonical core completion painter. @module remote/completion-drawer */
import { CompletionDrawer, type MayflyEditor, type MayflyScreenService, type MayflySemanticColors, type CompletionDrawerSource } from '@ephemeral-ai/mayfly/core'

/** Mount the reference completion palette above the same persistent editor. */
export function mountRemoteCompletionDrawer(
  screen: MayflyScreenService,
  editor: MayflyEditor,
  colors: MayflySemanticColors,
  components: CompletionDrawerSource['components'],
): { dispose(): void } {
  if (typeof (screen as { showOverlay?: unknown }).showOverlay !== 'function') return { dispose() {} }
  const drawer = new CompletionDrawer({
    view: () => editor.completion(),
    frameWidth: () => Math.max(1, screen.columns),
    colors,
    components,
    glyphs: undefined,
    wait: () => undefined,
  })
  const handle = screen.showOverlay(drawer, {
    anchor: 'bottom-left',
    nonCapturing: true,
    get width() { return drawer.width },
    get offsetY() { return -screen.editorRowsFromBottom },
    visible: () => drawer.open,
  })
  return { dispose() { handle.hide() } }
}
