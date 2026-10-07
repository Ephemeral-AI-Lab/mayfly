/** The arm delay of an overlay that opens unprompted: for `armMs` after it first takes focus, every key but `Esc` is swallowed.
 * @module @ephemeral-ai/mayfly/core/overlay-arm
 */
import { matchesKey, type KeyId } from '@earendil-works/pi-tui'

/** A hint the compiler paints in the surface's hint row while the overlay is armed. */
export interface OverlayArmHint {
  readonly id: string
  readonly keys: string
  readonly label: string
  readonly compact: string
  readonly priority: number
}

const ARMED_HINT: readonly OverlayArmHint[] = Object.freeze([Object.freeze({ id: 'armed', keys: '…', label: 'ready in a moment', compact: '…', priority: 100 })])

/**
 * One overlay's arm window. The timer is owned by the overlay component that created it: `dispose()` cancels it and
 * bumps the generation, so a callback of a disposed or restarted window can never repaint or arm anything.
 * Reduced motion and `NO_COLOR` do not shorten it; the delay protects against stray keys, not against motion.
 */
export class OverlayArm {
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private started = false
  private elapsed = false

  constructor(private readonly ms: number, private readonly onElapsed: () => void) {}

  /** True until the window has run its full length; a disposed arm stays armed so late keys still grant nothing. */
  get armed(): boolean { return !this.elapsed }

  /** The window opens when the overlay first takes focus; later focus changes do not extend it. */
  start(): void {
    if (this.started) return
    this.started = true
    const generation = ++this.generation
    this.timer = setTimeout(() => {
      /* v8 ignore next -- dispose() clears the timer, so a stale callback is a safety net only. */
      if (generation !== this.generation) return
      this.timer = undefined
      this.elapsed = true
      this.onElapsed()
    }, this.ms)
  }

  /** True when the key must not reach the surface: anything but `Esc` while armed. */
  swallows(data: string): boolean { return this.armed && !matchesKey(data, 'escape' as KeyId) }

  /** The hint row names the arm state until the window closes. */
  hints(): readonly OverlayArmHint[] { return this.armed ? ARMED_HINT : [] }

  /** Cancel the timer; the arm never fires again. */
  dispose(): void {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
