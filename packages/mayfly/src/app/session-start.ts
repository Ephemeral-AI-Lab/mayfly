/** Lazy session start: the session behind the first message.
 * @module @ephemeral-ai/mayfly/app/session-start
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflySessionStart: MayflySessionStartService }
}

/**
 * Mayfly starts without a session, so an empty session never reaches the
 * store; the editor asks this service for the primary Agent when the first
 * message is sent. The app driver owns creation and selection and runs them
 * on its serial chain.
 */
export class MayflySessionStartService extends Service {
  private booted = false
  private readonly listeners = new Set<() => void>()
  /** The plan mode the first session created from the start surface takes. */
  private plan = false
  private readonly planListeners = new Set<(active: boolean) => void>()

  constructor(ctx: Context, private readonly start: () => Promise<Agent>) {
    super(ctx, 'mayflySessionStart')
    ctx.effect(() => () => {
      this.listeners.clear()
      this.planListeners.clear()
      this.plan = false
    })
  }

  /**
   * Mark startup done: the loader settled and the launch values (resume, task)
   * are applied or absent. Called once by the app driver.
   */
  markBooted(): void {
    if (this.booted) return
    this.booted = true
    for (const listener of [...this.listeners]) listener()
    this.listeners.clear()
  }

  /**
   * Run `listener` once startup is done — at once when it already is. This is
   * the post-boot signal that used to be the first non-null Agent: with a lazy
   * session the screen can be live long before any Agent exists.
   * @returns a disposer for a listener that has not run yet.
   */
  onBooted(listener: () => void): () => void {
    if (this.booted) {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Whether the start surface's first session should enter plan mode. The
   * selection is pending only while no session is selected; the app applies
   * it after creating the session and before the first message reaches it.
   * @returns the pending selection.
   */
  planActive(): boolean {
    return this.plan
  }

  /**
   * Replace the start surface's pending plan selection.
   * @param active - whether the next created session should enter plan mode.
   */
  setPlanActive(active: boolean): void {
    if (this.plan === active) return
    this.plan = active
    for (const listener of [...this.planListeners]) listener(active)
  }

  /**
   * Observe pending plan changes; read the current value with `planActive()`.
   * @returns the disposer removing the listener.
   */
  subscribePlan(listener: (active: boolean) => void): () => void {
    this.planListeners.add(listener)
    return () => { this.planListeners.delete(listener) }
  }

  /**
   * The selected primary Agent, creating and selecting a session first when
   * none exists. Concurrent callers share the one session.
   * @returns the primary Agent; rejects when the session cannot be created or the app unloads.
   */
  ensure(): Promise<Agent> {
    return this.start()
  }
}
