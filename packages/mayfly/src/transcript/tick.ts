/**
 * The one clock the stream and the activity row keep time by. A call's pending line and the turn's vitals both show
 * seconds, so both read the same `now` from the same tick instead of arming a timer each. The clock runs only while
 * someone listens, and a listener never keeps a stale generation alive: unloading the service stops it.
 *
 * @module @ephemeral-ai/mayfly/transcript/tick
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** How often the listeners hear the time. */
export const TICK_MS = 1000

/** What a consumer needs of the clock; the controller and the pane take this, not the service. */
export interface TickSource {
  /**
   * Listen to the clock.
   * @param listener - called with the time of each tick.
   * @returns a disposer removing exactly this listener; safe to call twice.
   */
  subscribe(listener: (now: number) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyTick: MayflyTickService }
}

/** The shared one-second tick of the host tree. */
export class MayflyTickService extends Service implements TickSource {
  private readonly listeners = new Set<(now: number) => void>()
  private timer: ReturnType<typeof setInterval> | undefined

  /**
   * Create the service.
   * @param ctx - the owning Cordis context.
   * @param now - the time source; tests pin it.
   */
  constructor(ctx: Context, private readonly now: () => number = () => Date.now()) {
    super(ctx, 'mayflyTick')
  }

  subscribe(listener: (now: number) => void): () => void {
    this.listeners.add(listener)
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        const now = this.now()
        for (const each of [...this.listeners]) each(now)
      }, TICK_MS)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  /** Stop the clock and forget every listener. */
  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }
}
