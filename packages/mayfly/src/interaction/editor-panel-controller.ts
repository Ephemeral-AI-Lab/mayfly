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

/** Owns only the currently mounted editor-dock panel host. */
export class EditorPanelController extends Service {
  private host: EditorPanelHost | undefined

  constructor(ctx: Context) { super(ctx, 'mayflyEditorPanels') }

  setHost(host: EditorPanelHost | undefined): void { this.host = host }

  mount(component: MayflyFocusable): () => void {
    return this.host?.mount(component) ?? (() => {})
  }

  dispose(): void { this.host = undefined }
}

export const mountEditorReplacement = (ctx: Context, component: MayflyFocusable): (() => void) => ctx.get('mayflyEditorPanels')?.mount(component) ?? (() => {})
