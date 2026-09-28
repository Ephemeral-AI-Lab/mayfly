/**
 * App-owned registry of the conversations the frontend can display: the
 * primary session plus its side conversations (BTW, subagents), the one
 * displayed selection, and the most-recently-displayed order. Descriptors are
 * frozen renderer-neutral data; Agent behavior stays on native dsh services.
 *
 * @module @ephemeral-ai/mayfly/app/conversation-views
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyConversations: MayflyConversationsService }
  interface Events {
    /** Close the displayed side conversation, or the F7 counterpart while the primary is displayed. */
    'mayfly/request-close-conversation'(): void
    /** Open the shared reply form for the displayed continuable child; does not send or resume it. */
    'mayfly/request-subagent-reply'(target: MayflySubagentOpen): void
  }
}

/** Side conversations retained beside the primary; the least recent drops first. */
export const MAX_SIDE_CONVERSATIONS = 32

/** What the displayed conversation accepts from the editor. */
export type MayflyConversationAccess = 'interactive' | 'resumable' | 'readonly'

/** How much renderer state a conversation may hold. */
export type MayflyConversationResidency = 'displayed' | 'retained' | 'listed'

/** Identity and presentation facts of one local side conversation to open. */
export type MayflyConversationOpen = Readonly<{
  readonly kind: 'btw'
  readonly sessionId: string
  readonly parentSessionId: string
  readonly label: string
  /** Last inherited event sequence; presentation starts after this floor. */
  readonly historyFloorSeq?: number
} | {
  readonly kind: 'subagent'
  readonly sessionId: string
  readonly parentSessionId: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
}>

/** Identity of one subagent conversation. */
export type MayflySubagentOpen = Extract<MayflyConversationOpen, { readonly kind: 'subagent' }>

interface ConversationViewState {
  /** Stable registry id; see {@link conversationId}. */
  readonly id: string
  readonly access: MayflyConversationAccess
  readonly residency: MayflyConversationResidency
}

/** One frozen displayable conversation. */
export type MayflyConversationView =
  | Readonly<{ readonly kind: 'primary', readonly sessionId: string } & ConversationViewState>
  | (Extract<MayflyConversationOpen, { readonly kind: 'btw' }> & ConversationViewState)
  | (MayflySubagentOpen & ConversationViewState)

/** A displayable subagent conversation. */
export type MayflySubagentConversation = Extract<MayflyConversationView, { readonly kind: 'subagent' }>

/** Renderer-neutral registry state. */
export interface MayflyConversationsSnapshot {
  readonly primaryId: string | null
  readonly displayedId: string | null
  /** Most recently displayed first; `recent[1]` is the F7 target. */
  readonly recent: readonly string[]
  /** The primary first, then side conversations in open order. */
  readonly views: readonly MayflyConversationView[]
  readonly revision: number
}

/** Stable registry id of one local session. */
export function conversationId(sessionId: string): string {
  return `session:${sessionId}`
}

function admit(view: MayflyConversationOpen): MayflyConversationOpen {
  return Object.freeze(view.kind === 'btw'
    ? {
        kind: 'btw',
        sessionId: view.sessionId,
        parentSessionId: view.parentSessionId,
        label: view.label,
        ...(view.historyFloorSeq === undefined ? {} : { historyFloorSeq: view.historyFloorSeq }),
      }
    : {
        kind: 'subagent',
        sessionId: view.sessionId,
        parentSessionId: view.parentSessionId,
        label: view.label,
        mode: view.mode,
      })
}

/** App-owned conversation registry and displayed selection. */
export class MayflyConversationsService extends Service {
  private primaryAgent: Agent | null = null
  private readonly sides = new Map<string, MayflyConversationOpen>()
  private recentIds: string[] = []
  private displayedId: string | null = null
  private currentRevision = 0
  private readonly listeners = new Set<(snapshot: MayflyConversationsSnapshot) => void>()

  constructor(ctx: Context) {
    super(ctx, 'mayflyConversations')
    ctx.on('agent/disposed', ({ agent }) => { this.onAgentDisposed(agent) })
    ctx.on('agent/created', ({ agent }) => {
      const side = this.sides.get(conversationId(String(agent.id)))
      if (side?.kind === 'subagent' && side.mode === 'continuable') this.publish()
    })
    ctx.on('mayfly/request-close-conversation', () => { this.close() })
    ctx.effect(() => () => {
      this.primaryAgent = null
      this.sides.clear()
      this.recentIds = []
      this.displayedId = null
      this.listeners.clear()
    })
  }

  /** Exact live primary Agent, or null after its registry identity vanished. */
  primary(): Agent | null {
    if (this.primaryAgent !== null && this.ctx.agents.get(this.primaryAgent.id) !== this.primaryAgent) {
      this.onAgentDisposed(this.primaryAgent)
    }
    return this.primaryAgent
  }

  /** Exact live Agent the displayed conversation drives, or null when it is not interactive. */
  displayedAgent(): Agent | null {
    const primary = this.primary()
    const side = this.displayedId === null ? undefined : this.sides.get(this.displayedId)
    if (side === undefined) return primary
    return side.kind === 'subagent' && side.mode === 'one-shot' ? null : this.liveAgent(side.sessionId)
  }

  /** Monotonic registry revision. */
  revision(): number { return this.currentRevision }

  /** Current frozen registry snapshot. */
  snapshot(): MayflyConversationsSnapshot {
    const primary = this.primary()
    const primaryId = primary === null ? null : conversationId(String(primary.id))
    const retained = new Set([primaryId, this.recentIds[1]])
    const residency = (id: string): MayflyConversationResidency => id === this.displayedId
      ? 'displayed'
      : retained.has(id) ? 'retained' : 'listed'
    const views: MayflyConversationView[] = []
    if (primary !== null) {
      views.push(Object.freeze({ kind: 'primary', id: primaryId!, sessionId: String(primary.id), access: 'interactive', residency: residency(primaryId!) }))
    }
    for (const [id, side] of this.sides) {
      views.push(Object.freeze({ ...side, id, access: this.access(side), residency: residency(id) }))
    }
    return Object.freeze({
      primaryId,
      displayedId: this.displayedId,
      recent: Object.freeze([...this.recentIds]),
      views: Object.freeze(views),
      revision: this.currentRevision,
    })
  }

  /** The displayed conversation, or null when no primary is selected. */
  displayed(): MayflyConversationView | null {
    const snapshot = this.snapshot()
    return snapshot.views.find(view => view.id === snapshot.displayedId) ?? null
  }

  /** Replay and observe registry changes. */
  subscribe(listener: (snapshot: MayflyConversationsSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  /** Select a new primary Agent, close every side conversation, and display it. */
  selectPrimary(agent: Agent | null): void {
    if (agent !== null && this.ctx.agents.get(agent.id) !== agent) {
      throw new Error(`cannot select non-live Agent "${String(agent.id)}"`)
    }
    const id = agent === null ? null : conversationId(String(agent.id))
    const changed = this.primaryAgent !== agent || this.sides.size > 0 || this.displayedId !== id
    this.primaryAgent = agent
    this.sides.clear()
    this.recentIds = id === null ? [] : [id]
    this.displayedId = id
    if (changed) this.publish()
  }

  /**
   * Add or refresh one side conversation and display it. A new BTW replaces
   * any other BTW; the least recent hidden side drops past the retention cap.
   * @returns the registry id.
   */
  open(view: MayflyConversationOpen): string {
    const primary = this.primary()
    if (primary === null) throw new Error('cannot open a side conversation without a live primary Agent')
    if (view.sessionId === String(primary.id)) throw new Error('cannot open the primary Agent as a side conversation')
    const admitted = admit(view)
    if (admitted.kind === 'btw' && this.liveAgent(admitted.sessionId) === null) {
      throw new Error(`cannot open non-live BTW Agent "${admitted.sessionId}"`)
    }
    const id = conversationId(admitted.sessionId)
    if (admitted.kind === 'btw') {
      for (const [other, side] of this.sides) if (side.kind === 'btw' && other !== id) this.forget(other)
    }
    this.sides.set(id, admitted)
    this.promote(id)
    while (this.sides.size > MAX_SIDE_CONVERSATIONS) {
      this.forget(this.recentIds.findLast(other => other !== id && this.sides.has(other))!)
    }
    this.publish()
    return id
  }

  /** Display one registered conversation. */
  display(id: string): boolean {
    const primary = this.primary()
    if (primary === null || (id !== conversationId(String(primary.id)) && !this.sides.has(id))) return false
    if (this.displayedId !== id) {
      this.promote(id)
      this.publish()
    }
    return true
  }

  /** Display the previously displayed conversation (F7). */
  back(): boolean {
    const target = this.recentIds[1]
    return target !== undefined && this.display(target)
  }

  /**
   * Close one side conversation. Without an id this closes the displayed side,
   * or the F7 counterpart while the primary is displayed. The primary never closes.
   * @returns the closed view, or null when nothing closed.
   */
  close(id?: string): MayflyConversationView | null {
    // Heal a stale primary first: its disposal clears every side.
    this.primary()
    const target = id ?? (this.displayedId !== null && this.sides.has(this.displayedId) ? this.displayedId : this.recentIds[1])
    if (target === undefined || !this.sides.has(target)) return null
    const closed = this.snapshot().views.find(view => view.id === target)!
    this.forget(target)
    this.publish()
    return closed
  }

  /** Close every side conversation and display the primary. */
  closeSides(): void {
    if (this.sides.size === 0) return
    // Sides exist only beside a primary: its disposal clears them too.
    const id = conversationId(String(this.primaryAgent!.id))
    this.sides.clear()
    this.recentIds = [id]
    this.displayedId = id
    this.publish()
  }

  private access(side: MayflyConversationOpen): MayflyConversationAccess {
    if (side.kind === 'subagent' && side.mode === 'one-shot') return 'readonly'
    if (this.liveAgent(side.sessionId) !== null) return 'interactive'
    return side.kind === 'subagent' ? 'resumable' : 'readonly'
  }

  private liveAgent(sessionId: string): Agent | null {
    return this.ctx.agents.get(sessionId as Agent['id']) ?? null
  }

  private promote(id: string): void {
    this.recentIds = [id, ...this.recentIds.filter(other => other !== id)]
    this.displayedId = id
  }

  private forget(id: string): void {
    this.sides.delete(id)
    this.recentIds = this.recentIds.filter(other => other !== id)
    // The primary stays in the recency order while any side exists.
    if (this.displayedId === id) this.displayedId = this.recentIds[0]!
  }

  private onAgentDisposed(agent: Agent): void {
    if (agent === this.primaryAgent) {
      this.primaryAgent = null
      this.sides.clear()
      this.recentIds = []
      this.displayedId = null
      this.publish()
      return
    }
    const id = conversationId(String(agent.id))
    const side = this.sides.get(id)
    if (side === undefined) return
    if (side.kind === 'btw') this.forget(id)
    this.publish()
  }

  private publish(): void {
    this.currentRevision += 1
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
