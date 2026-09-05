/** Fiber-scoped controller for the fixed editor dock's replacement panel stack.
 * @module @ephemeral-ai/mayfly/interaction/editor-panel-controller
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { MayflyFocusable } from '../core/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyEditorPanels: EditorPanelController }
}

export interface EditorPanelHost {
  readonly mount: (component: MayflyFocusable) => () => void
}

interface PanelEntry {
  readonly component: MayflyFocusable
  unmount: (() => void) | undefined
}

/** Owns the logical editor-panel stack and replays it across dock hosts. */
export class EditorPanelController extends Service {
  private host: EditorPanelHost | undefined
  private readonly entries: PanelEntry[] = []
  private live = true

  constructor(ctx: Context) { super(ctx, 'mayflyEditorPanels') }

  setHost(host: EditorPanelHost | undefined): void {
    if (!this.live || host === this.host) return
    for (const entry of this.entries.toReversed()) {
      entry.unmount?.()
      entry.unmount = undefined
    }
    this.host = host
    if (host === undefined) return
    const mounted: PanelEntry[] = []
    try {
      for (const entry of this.entries) {
        entry.unmount = host.mount(entry.component)
        mounted.push(entry)
      }
    } catch (error) {
      for (const entry of mounted.toReversed()) {
        entry.unmount?.()
        entry.unmount = undefined
      }
      this.host = undefined
      throw error
    }
  }

  mount(component: MayflyFocusable): () => void {
    if (!this.live) return () => {}
    const entry: PanelEntry = { component, unmount: undefined }
    this.entries.push(entry)
    try {
      entry.unmount = this.host?.mount(component)
    } catch (error) {
      this.entries.pop()
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      entry.unmount?.()
      entry.unmount = undefined
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  dispose(): void {
    if (!this.live) return
    this.setHost(undefined)
    this.live = false
    this.entries.splice(0)
  }
}

export const mountEditorReplacement = (ctx: Context, component: MayflyFocusable): (() => void) => ctx.get('mayflyEditorPanels')?.mount(component) ?? (() => {})
