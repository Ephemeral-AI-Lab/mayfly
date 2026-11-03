/** Viewport window math shared by scrollable Mayfly surfaces.
 * @module @ephemeral-ai/mayfly/core/window-controller
 */

export interface MayflyWindow {
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
}

/** Pure cursor/window controller; it owns no renderer or terminal state. */
export class WindowController {
  private offsetValue = 0
  private limitValue = 1
  private totalValue = 0

  get offset(): number { return this.offsetValue }
  get limit(): number { return this.limitValue }
  get total(): number { return this.totalValue }

  update(total: number, limit: number, requestedOffset = this.offsetValue): MayflyWindow {
    this.totalValue = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0)
    this.limitValue = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1)
    const maxOffset = Math.max(0, this.totalValue - this.limitValue)
    this.offsetValue = Math.min(maxOffset, Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0))
    return this.snapshot()
  }

  move(delta: number): MayflyWindow {
    return this.update(this.totalValue, this.limitValue, this.offsetValue + (Number.isFinite(delta) ? Math.floor(delta) : 0))
  }

  clone(): WindowController {
    const copy = new WindowController()
    copy.update(this.totalValue, this.limitValue, this.offsetValue)
    return copy
  }

  snapshot(): MayflyWindow {
    return Object.freeze({
      offset: this.offsetValue,
      limit: this.limitValue,
      total: this.totalValue,
      hasPrevious: this.offsetValue > 0,
      hasNext: this.offsetValue + this.limitValue < this.totalValue,
    })
  }
}
