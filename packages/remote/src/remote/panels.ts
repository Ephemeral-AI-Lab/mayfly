/**
 * Generation-safe base overlay host for independent Remote feature panels.
 * @module @ephemeral-ai/mayfly/remote/panels
 */

import type {
  MayflyComponent,
  MayflyFocusable,
  MayflyOverlayHandle,
  MayflyOverlayOptions,
  MayflyScreen,
} from '@ephemeral-ai/mayfly/core'

/**
 * Make a panel an opaque overlay: every rendered row is padded to the overlay's
 * width, so the row the content painted underneath cannot show through the
 * columns a panel row happens to leave empty. The in-process TUI gets this from
 * the `chrome: 'overlay'` surface; Remote panels are plain components, so the
 * host applies it once here instead of in every feature's painter.
 */
class OpaqueOverlay implements MayflyFocusable {
  constructor(private readonly inner: MayflyFocusable) {}

  get focused(): boolean { return this.inner.focused }
  set focused(value: boolean) { this.inner.focused = value }

  handleInput(data: string): void { this.inner.handleInput?.(data) }

  render(width: number): string[] {
    return this.inner.render(width).map((row) => {
      const plain = row.replace(/\x1b\[[0-9;]*m/gu, '')
      const missing = width - [...plain].length
      return missing > 0 ? `${row}${' '.repeat(missing)}` : row
    })
  }

  invalidate(): void { this.inner.invalidate() }
}

/**
 * The one sizing policy for a Remote panel overlay.
 *
 * A panel is a plain component here, not a `ui.surface` with `chrome:
 * 'overlay'`, so it inherits none of that surface's guarantees. Two of them
 * matter and both are defects when missing: a percentage width leaves the
 * columns beside the panel showing whatever it was supposed to cover, and
 * rows that stop at their own text length let the covered rows show through
 * the gaps. The host therefore owns the full row and pads every panel row.
 * @param screen - the owner of the terminal dimensions.
 * @param options - caller overrides applied over the defaults.
 * @returns overlay options that cover the whole row.
 */
export function remotePanelOverlayOptions(
  screen: MayflyScreen,
  options: MayflyOverlayOptions = {},
): MayflyOverlayOptions {
  return {
    width: screen.columns,
    maxHeight: '80%',
    anchor: 'center',
    ...options,
  }
}

/** Options for one component overlay owned by the Remote panel host. */
export interface RemoteOverlayOpenOptions extends MayflyOverlayOptions {
  /** Called once when this lease closes, is replaced, or its owner is disposed. */
  readonly onClosed?: () => void
}

/** One generation of the active Remote component overlay. */
export interface RemoteOverlayLease {
  readonly generation: number
  readonly closed: boolean
  /** Close only this generation and restore the editor when no replacement took focus. */
  close(): void
}

/** Feature-facing component overlay host; feature modules own their panels and data. */
export interface RemoteOverlayHost {
  /** Replace the active component overlay without granting or cancelling feature work. */
  open(component: MayflyFocusable, options?: RemoteOverlayOpenOptions): RemoteOverlayLease
  /** Close the active component overlay and restore the editor. */
  close(): void
}

interface ActiveOverlay {
  readonly generation: number
  readonly handle: MayflyOverlayHandle
  readonly onClosed?: () => void
  closed: boolean
}

/** Own one active Remote component overlay, its replacement generation, and editor focus restoration. */
export class RemotePanelController implements RemoteOverlayHost {
  private active: ActiveOverlay | undefined
  private generation = 0

  constructor(
    private readonly screen: MayflyScreen,
    private readonly restoreFocus: () => void,
    /** Present when the host should paint panels as opaque overlays. */
    private readonly opaque: boolean = false,
  ) {}

  open(component: MayflyFocusable, options: RemoteOverlayOpenOptions = {}): RemoteOverlayLease {
    this.closeActive(false)
    const generation = ++this.generation
    const { onClosed, ...overlayOptions } = options
    let record!: ActiveOverlay
    const lease: RemoteOverlayLease = {
      generation,
      get closed() { return record.closed },
      close: () => {
        if (this.active !== record || record.closed) return
        this.closeActive(true)
      },
    }
    const opaque: MayflyComponent = this.opaque
      ? new OpaqueOverlay(component) as unknown as MayflyComponent
      : component
    const handle = this.screen.showOverlay(opaque, remotePanelOverlayOptions(this.screen, {
      maxHeight: '70%',
      ...overlayOptions,
    }))
    record = { generation, handle, ...onClosed === undefined ? {} : { onClosed }, closed: false }
    this.active = record
    // The overlay covers rows the content already painted. The differential
    // writer only emits cells whose value changed, so cells where the panel's
    // row happens to repeat the transcript (spaces, shared glyphs) would keep
    // the old text visible under it. A forced repaint rewrites the whole frame.
    this.screen.requestRender(true)
    return lease
  }

  close(): void {
    this.closeActive(true)
  }

  /** Close the active generation without settling any feature request. */
  dispose(): void {
    this.generation += 1
    this.closeActive(false)
  }

  private closeActive(restore: boolean): void {
    const record = this.active
    if (record === undefined) return
    this.active = undefined
    this.generation = Math.max(this.generation, record.generation + 1)
    record.closed = true
    record.handle.hide()
    try {
      record.onClosed?.()
    } finally {
      if (restore && this.active === undefined) this.restoreFocus()
      // Closing restores the rows the panel covered; their content differs from
      // the panel's, so the next frame must be painted whole.
      this.screen.requestRender(true)
    }
  }
}
