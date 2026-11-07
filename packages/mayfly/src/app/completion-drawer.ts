/** The standalone editor uses the canonical core completion painter. @module @ephemeral-ai/mayfly/app/completion-drawer */
import type { Context } from '@deepseek-ai/cordis'
import { CompletionDrawer, type CompletionDrawerSource } from '../core/completion-drawer.ts'
import type { MayflyEditor, MayflySemanticColors } from '../core/types.ts'
import type { MayflyScreenService } from '../core/screen.ts'

/** Mount the reference completion palette above the same persistent editor. */
export function mountRemoteCompletionDrawer(
  ctx: Context,
  screen: MayflyScreenService,
  editor: MayflyEditor,
  colors: MayflySemanticColors,
  components: CompletionDrawerSource['components'] & { readonly presentation?: { readonly glyphs: 'unicode' | 'ascii' } },
): { dispose(): void } {
  if (typeof (screen as { showOverlay?: unknown }).showOverlay !== 'function') return { dispose() {} }
  let disposed = false
  let waiting: string | undefined
  const offWait = ctx.on('mayfly/prompt-wait-changed', message => {
    if (disposed) return
    waiting = message
    screen.requestRender()
  })
  const drawer = new CompletionDrawer({
    view: () => editor.completion(),
    frameWidth: () => Math.max(1, screen.columns),
    colors,
    components,
    glyphs: components.presentation?.glyphs,
    wait: () => waiting,
  })
  const handle = screen.showOverlay(drawer, {
    anchor: 'bottom-left',
    nonCapturing: true,
    get width() { return drawer.width },
    get offsetY() { return -screen.editorRowsFromBottom },
    visible: () => drawer.open,
  })
  return { dispose() {
    if (disposed) return
    disposed = true
    offWait()
    handle.hide()
  } }
}
