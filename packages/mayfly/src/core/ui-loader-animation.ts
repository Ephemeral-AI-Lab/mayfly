/** Renderer-owned animation clock; only painted surfaces request another frame, and one timer serves them all.
 * @module @ephemeral-ai/mayfly/core/ui-loader-animation
 */
export const LOADER_FRAME_MS = 80

/**
 * The one timer behind every animated surface of a renderer. A surface arms its animation while it paints a moving cell
 * and leaves when it hides, so the timer exists only while something is armed. A caller that wants no sharing gives
 * each animation its own clock.
 */
export class UiAnimationClock {
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly armed = new Set<UiLoaderAnimation>()

  /** Joins the next tick, starting the timer when none is pending. */
  arm(member: UiLoaderAnimation): void {
    this.armed.add(member)
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      const due = [...this.armed]
      this.armed.clear()
      for (const animation of due) animation.fire()
    }, LOADER_FRAME_MS)
  }

  /** Leaves the next tick; the timer is cancelled once nothing is armed. */
  disarm(member: UiLoaderAnimation): void {
    this.armed.delete(member)
    if (this.armed.size === 0) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Cancels the pending tick and forgets every member. */
  dispose(): void {
    this.armed.clear()
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

export class UiLoaderAnimation {
  private painted = false
  private frameValue = 0

  constructor(private readonly requestRender: () => void, private readonly clock: UiAnimationClock = new UiAnimationClock()) {}

  get frame(): number { return this.frameValue }

  /** A fresh paint/rebind must encounter a loader to keep its clock running. */
  beginFrame(): void { this.painted = false }

  /** All loaders within one surface share a clock, independent of data updates. */
  render(): number {
    this.painted = true
    this.clock.arm(this)
    return this.frameValue
  }

  /** Called by the clock on a tick: a surface that did not paint since its last frame stays out of the next one. */
  fire(): void {
    if (!this.painted) return
    this.painted = false
    this.frameValue++
    this.requestRender()
  }

  /** Hiding, deactivation, or renderer disposal cancels the pending repaint. */
  stop(): void {
    this.clock.disarm(this)
    this.painted = false
  }
}
