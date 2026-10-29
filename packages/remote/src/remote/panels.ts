/**
 * Generation-safe base overlay host for independent Remote feature panels.
 * @module @ephemeral-ai/mayfly/remote/panels
 */

import type {
  MayflyFocusable,
  MayflyOverlayHandle,
  MayflyOverlayOptions,
  MayflyScreen,
} from '@ephemeral-ai/mayfly/core'

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
    const handle = this.screen.showOverlay(component, {
      width: '80%',
      maxHeight: '70%',
      ...overlayOptions,
    })
    record = { generation, handle, ...onClosed === undefined ? {} : { onClosed }, closed: false }
    this.active = record
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
    }
  }
}
