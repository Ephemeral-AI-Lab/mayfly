/** Renderer-owned loader clock; only painted surfaces request another frame.
 * @module @ephemeral-ai/mayfly/core/ui-loader-animation
 */
export const LOADER_FRAME_MS = 80

export class UiLoaderAnimation {
  private timer: ReturnType<typeof setTimeout> | undefined
  private painted = false
  private owner: unknown
  private frameValue = 0

  constructor(private readonly requestRender: () => void) {}

  get frame(): number { return this.frameValue }

  /** A fresh paint/rebind must encounter a loader to keep its clock running. */
  beginFrame(): void { this.painted = false; this.owner = undefined }

  /** All loaders within one surface share a clock, independent of data updates. */
  render(interval = LOADER_FRAME_MS, reducedMotion = false, owner: unknown = this): number {
    if (reducedMotion) { this.stop(); return 0 }
    if (this.owner !== undefined && this.owner !== owner) return 0
    this.owner = owner
    this.painted = true
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      if (!this.painted) return
      this.painted = false
      this.frameValue++
      this.requestRender()
    }, interval)
    return this.frameValue
  }

  /** Hiding, deactivation, or renderer disposal cancels the pending repaint. */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.painted = false
  }
}
