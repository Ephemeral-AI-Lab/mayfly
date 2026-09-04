/** Current raw dsh Agent selected by the Mayfly frontend tree.
 * @module @ephemeral-ai/mayfly/app/current-agent
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyCurrentAgent: MayflyCurrentAgentService }
  interface Events { 'mayfly/request-close-agent-view'(): void }
}

/** One auxiliary conversation the frontend may display beside its primary. */
export type MayflyAuxiliaryView = Readonly<{
  readonly kind: 'btw'
  readonly sessionId: string
  readonly parentSessionId: string
  readonly label: string
} | {
  readonly kind: 'subagent'
  readonly sessionId: string
  readonly parentSessionId: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
}>

/** Renderer-neutral current view state. */
export interface MayflyAgentViewSnapshot {
  readonly primarySessionId: string | null
  readonly displayed: 'primary' | 'auxiliary'
  readonly auxiliary: (MayflyAuxiliaryView & { readonly access: 'interactive' | 'readonly' }) | null
  readonly revision: number
}

/** App-owned primary/auxiliary selection service; Agent behavior stays native. */
export class MayflyCurrentAgentService extends Service {
  private selected: Agent | null = null
  private primaryAgent: Agent | null = null
  private auxiliaryView: MayflyAuxiliaryView | null = null
  private auxiliaryDisplayed = false
  private currentRevision = 0
  private viewRevision = 0
  private readonly listeners = new Set<(agent: Agent | null, revision: number) => void>()
  private readonly viewListeners = new Set<(snapshot: MayflyAgentViewSnapshot) => void>()

  constructor(ctx: Context) {
    super(ctx, 'mayflyCurrentAgent')
    ctx.on('agent/disposed', ({ agent }) => {
      this.onAgentDisposed(agent)
    })
    ctx.on('agent/created', ({ agent }) => {
      if (this.auxiliaryView?.kind !== 'subagent'
        || this.auxiliaryView.mode !== 'continuable'
        || String(agent.id) !== this.auxiliaryView.sessionId) return
      if (this.auxiliaryDisplayed) this.publish(agent)
      this.publishView()
    })
    ctx.on('mayfly/request-close-agent-view', () => { this.closeAuxiliary() })
    ctx.effect(() => () => {
      this.selected = null
      this.primaryAgent = null
      this.auxiliaryView = null
      this.auxiliaryDisplayed = false
      this.listeners.clear()
      this.viewListeners.clear()
    })
  }

  /** Exact live Agent, or null when no Agent is selected. */
  current(): Agent | null {
    if (this.selected !== null && this.ctx.agents.get(this.selected.id) !== this.selected) {
      this.onAgentDisposed(this.selected)
    }
    return this.selected
  }

  /** Exact live primary Agent, or null after its registry identity vanished. */
  primary(): Agent | null {
    if (this.primaryAgent !== null && this.ctx.agents.get(this.primaryAgent.id) !== this.primaryAgent) {
      this.onAgentDisposed(this.primaryAgent)
    }
    return this.primaryAgent
  }

  /** Monotonic selection revision. */
  revision(): number { return this.currentRevision }

  /** Replay and observe exact Agent selection changes. */
  subscribe(listener: (agent: Agent | null, revision: number) => void): () => void {
    this.listeners.add(listener)
    listener(this.current(), this.currentRevision)
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  /** Select a new primary Agent and close any auxiliary view. */
  select(agent: Agent | null): void {
    this.assertLive(agent)
    const viewChanged = this.primaryAgent !== agent || this.auxiliaryView !== null || this.auxiliaryDisplayed
    this.primaryAgent = agent
    this.auxiliaryView = null
    this.auxiliaryDisplayed = false
    this.publish(agent)
    if (viewChanged) this.publishView()
  }

  /** Current primary/auxiliary display snapshot. */
  view(): MayflyAgentViewSnapshot {
    const auxiliary = this.auxiliaryView
    return Object.freeze({
      primarySessionId: this.primaryAgent === null ? null : String(this.primaryAgent.id),
      displayed: auxiliary !== null && this.auxiliaryDisplayed ? 'auxiliary' : 'primary',
      auxiliary: auxiliary === null ? null : Object.freeze({
        ...auxiliary,
        access: this.auxiliaryAgent(auxiliary) === null ? 'readonly' : 'interactive',
      }),
      revision: this.viewRevision,
    })
  }

  /** Replay and observe auxiliary display state. */
  subscribeView(listener: (snapshot: MayflyAgentViewSnapshot) => void): () => void {
    this.viewListeners.add(listener)
    listener(this.view())
    return this.ctx.effect(() => () => { this.viewListeners.delete(listener) })
  }

  /** Replace the single auxiliary slot and display it immediately. */
  openAuxiliary(view: MayflyAuxiliaryView): void {
    if (this.primary() === null) throw new Error('cannot open an auxiliary view without a live primary Agent')
    if (view.sessionId === String(this.primaryAgent!.id)) throw new Error('cannot open the primary Agent as an auxiliary view')
    const admitted = Object.freeze({ ...view }) as MayflyAuxiliaryView
    const auxiliary = this.auxiliaryAgent(admitted)
    if (admitted.kind === 'btw' && auxiliary === null) {
      throw new Error(`cannot open non-live BTW Agent "${admitted.sessionId}"`)
    }
    this.auxiliaryView = admitted
    this.auxiliaryDisplayed = true
    this.publish(auxiliary ?? this.primaryAgent)
    this.publishView()
  }

  /** Toggle between the retained primary and auxiliary display. */
  toggleAuxiliary(): boolean {
    const auxiliary = this.auxiliaryView
    if (auxiliary === null) return false
    this.auxiliaryDisplayed = !this.auxiliaryDisplayed
    this.publish(this.auxiliaryDisplayed ? this.auxiliaryAgent(auxiliary) ?? this.primaryAgent : this.primaryAgent)
    this.publishView()
    return true
  }

  /** Close the auxiliary slot and return to the primary Agent. */
  closeAuxiliary(): MayflyAuxiliaryView | null {
    const previous = this.auxiliaryView
    if (previous === null) return null
    this.auxiliaryView = null
    this.auxiliaryDisplayed = false
    this.publish(this.primaryAgent)
    this.publishView()
    return previous
  }

  private assertLive(agent: Agent | null): void {
    if (agent !== null && this.ctx.agents.get(agent.id) !== agent) {
      throw new Error(`cannot select non-live Agent "${String(agent.id)}"`)
    }
  }

  private auxiliaryAgent(view: MayflyAuxiliaryView): Agent | null {
    if (view.kind === 'subagent' && view.mode === 'one-shot') return null
    return this.ctx.agents.get(view.sessionId as Agent['id']) ?? null
  }

  private onAgentDisposed(agent: Agent): void {
    if (agent === this.primaryAgent) {
      this.primaryAgent = null
      this.auxiliaryView = null
      this.auxiliaryDisplayed = false
      this.publish(null)
      this.publishView()
      return
    }
    const auxiliary = this.auxiliaryView
    if (auxiliary === null || String(agent.id) !== auxiliary.sessionId) return
    if (auxiliary.kind === 'btw') {
      this.closeAuxiliary()
      return
    }
    if (agent === this.selected) this.publish(this.primaryAgent)
    this.publishView()
  }

  private publishView(): void {
    this.viewRevision += 1
    const snapshot = this.view()
    for (const listener of this.viewListeners) listener(snapshot)
  }

  private publish(agent: Agent | null): void {
    if (agent === this.selected) return
    this.selected = agent
    this.currentRevision += 1
    for (const listener of this.listeners) listener(agent, this.currentRevision)
  }
}
