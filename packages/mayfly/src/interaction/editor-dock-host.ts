/**
 * Stable editor-dock host switching one persistent editor shell with a panel stack.
 *
 * @module @ephemeral-ai/mayfly/interaction/editor-dock-host
 */
import type { MayflyComponent, MayflyFocusable } from '../core/index.ts'

interface PanelEntry {
  readonly component: MayflyFocusable
  disposed: boolean
}

/** One stable focusable leaf for the screen's named editor slot. */
export class EditorDockHost implements MayflyFocusable {
  private focusedValue = false
  private live = true
  private readonly panels: PanelEntry[] = []

  constructor(
    private readonly editor: MayflyFocusable,
    private readonly hint: MayflyComponent,
    private readonly onOccupancyChange: (occupied: boolean) => void,
  ) {}

  get focused(): boolean { return this.live && this.focusedValue }
  set focused(value: boolean) {
    const previous = this.activeFocusable()
    previous.focused = false
    this.focusedValue = this.live && value
    const next = this.activeFocusable()
    next.focused = this.focusedValue
  }

  render(width: number): string[] {
    if (!this.live) return []
    const panel = this.panels.at(-1)?.component
    return panel === undefined
      ? [...this.editor.render(width), ...this.hint.render(width)]
      : panel.render(width)
  }

  /** Render only the transient hint rows for diagnostics and focused tests. */
  renderHint(width: number): string[] { return this.live && this.panels.length === 0 ? this.hint.render(width) : [] }

  invalidate(): void {
    if (!this.live) return
    const panel = this.panels.at(-1)?.component
    if (panel === undefined) {
      this.editor.invalidate()
      this.hint.invalidate()
    } else panel.invalidate()
  }

  handleInput(data: string): void {
    if (this.live) this.activeFocusable()?.handleInput?.(data)
  }

  mountPanel(component: MayflyFocusable): () => void {
    if (!this.live) return () => {}
    const wasEmpty = this.panels.length === 0
    const previous = this.activeFocusable()
    previous.focused = false
    const entry: PanelEntry = { component, disposed: false }
    this.panels.push(entry)
    component.focused = this.focusedValue
    if (wasEmpty) this.onOccupancyChange(true)
    return () => {
      if (entry.disposed) return
      entry.disposed = true
      const index = this.panels.indexOf(entry)
      const wasTop = index === this.panels.length - 1
      this.panels.splice(index, 1)
      component.focused = false
      if (this.panels.length === 0) this.onOccupancyChange(false)
      if (wasTop) {
        const next = this.activeFocusable()
        next.focused = this.focusedValue
      }
    }
  }

  dispose(): void {
    if (!this.live) return
    const occupied = this.panels.length > 0
    this.focused = false
    for (const panel of this.panels.splice(0)) {
      panel.disposed = true
      panel.component.focused = false
    }
    this.live = false
    if (occupied) this.onOccupancyChange(false)
  }

  private activeFocusable(): MayflyFocusable {
    return this.panels.at(-1)?.component ?? this.editor
  }
}
