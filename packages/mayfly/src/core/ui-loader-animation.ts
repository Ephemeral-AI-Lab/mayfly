/** Renderer-owned loader clock; only painted surfaces request another frame.
 * @module @ephemeral-ai/mayfly/core/ui-loader-animation
 */
export const LOADER_FRAME_MS = 80

export class UiLoaderAnimation {
  private timer: ReturnType<typeof setTimeout> | undefined
  private painted = false
  private frameValue = 0

  constructor(private readonly requestRender: () => void) {}

  get frame(): number { return this.frameValue }

  /** A fresh paint/rebind must encounter a loader to keep its clock running. */
  beginFrame(): void { this.painted = false }

  /** All loaders within one surface share a clock, independent of data updates. */
  render(): number {
    this.painted = true
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      if (!this.painted) return
      this.painted = false
      this.frameValue++
      this.requestRender()
    }, LOADER_FRAME_MS)
    return this.frameValue
  }

  /** Hiding, deactivation, or renderer disposal cancels the pending repaint. */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.painted = false
  }
}
