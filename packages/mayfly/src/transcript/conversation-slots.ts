/**
 * Binds the app conversation registry to transcript views. The displayed and
 * retained conversations each hold a model source over their native read
 * path; listed ones hold nothing, so many open conversations cost only their
 * descriptors. A hidden view stashes its latest value and converts only when
 * it is displayed again.
 *
 * @module @ephemeral-ai/mayfly/transcript/conversation-slots
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { MayflyConversationsSnapshot, MayflyConversationView } from '../app/conversation-views.ts'
import { watchAssistantStream } from '../frontend/assistant-stream.ts'
import { AddressConversationFeed, type ConversationHistorySource } from './conversation-feed.ts'
import type { OfficialConversationModelSource } from './official-model.ts'
import type { TranscriptController, TranscriptModelRenderer } from './transcript-model.ts'

/** The native read path of one conversation. */
type Binding =
  | { readonly kind: 'session', readonly session: Session, readonly agent: Agent | undefined }
  | { readonly kind: 'address', readonly address: SessionAddress }
  | { readonly kind: 'none' }

interface Slot {
  readonly binding: Binding
  readonly floor: number | undefined
  readonly headed: boolean
  readonly source: OfficialConversationModelSource
  readonly release: () => void
}

/** Collaborators the slots build sources and read native history with. */
export interface ConversationSlotsOptions {
  /** Build one model source; `agent` scopes tool presenters, `publish` wakes the renderer. */
  readonly source: (agent: Agent | undefined, publish: () => void) => OfficialConversationModelSource
  /** Renderer options for a view without its own activity row. */
  readonly headed: Partial<TranscriptModelRenderer>
  readonly history: () => ConversationHistorySource | undefined
}

function sameBinding(left: Binding, right: Binding): boolean {
  if (left.kind === 'session' && right.kind === 'session') return left.session === right.session && left.agent === right.agent
  return left.kind === right.kind
}

/** Registry-driven transcript views for one transcript Fiber. */
export class ConversationSlots {
  private readonly slots = new Map<string, Slot>()
  private displayed: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly transcript: TranscriptController,
    private readonly options: ConversationSlotsOptions,
  ) {}

  /** Reconcile views with one registry snapshot and show the displayed one. */
  sync(snapshot: MayflyConversationsSnapshot): void {
    const wanted = new Map(snapshot.views.filter(view => view.residency !== 'listed').map(view => [view.id, view]))
    for (const id of this.slots.keys()) if (!wanted.has(id)) this.drop(id)
    for (const view of wanted.values()) {
      const binding = this.bindingOf(view)
      const floor = view.kind === 'btw' ? view.historyFloorSeq : undefined
      // Only views without an activity row (no driven Agent) tick their own header.
      const headed = view.access !== 'interactive'
      const slot = this.slots.get(view.id)
      if (slot !== undefined && sameBinding(slot.binding, binding) && slot.floor === floor && slot.headed === headed) continue
      if (slot !== undefined) this.drop(view.id)
      this.create(view.id, binding, floor, headed)
    }
    this.displayed = snapshot.displayedId ?? undefined
    this.transcript.show(this.displayed)
  }

  /** Re-resolve tool presenters in every retained view. */
  invalidateTools(): void {
    for (const slot of this.slots.values()) slot.source.invalidateTools()
  }

  dispose(): void {
    for (const id of this.slots.keys()) this.drop(id)
    this.displayed = undefined
  }

  private bindingOf(view: MayflyConversationView): Binding {
    const agent = view.kind === 'primary'
      ? this.ctx.mayflyConversations.primary()
      : this.ctx.agents.get(SessionId(view.sessionId)) ?? null
    if (agent !== null) return { kind: 'session', session: agent.session, agent }
    // A one-shot run may keep a live Session without a registered Agent.
    const session = this.ctx.sessions.list().find(candidate => String(candidate.id) === view.sessionId)
    if (session !== undefined) return { kind: 'session', session, agent: undefined }
    return view.kind === 'subagent'
      ? { kind: 'address', address: { kind: 'subagent', parentSessionId: SessionId(view.parentSessionId), childSessionId: SessionId(view.sessionId), mode: view.mode } }
      : { kind: 'none' }
  }

  private create(id: string, binding: Binding, floor: number | undefined, headed: boolean): void {
    const agent = binding.kind === 'session' ? binding.agent : undefined
    // A hidden view keeps its newest value stashed and wakes nothing.
    const source = this.options.source(agent, () => { if (this.displayed === id) this.transcript.refresh() })
    if (binding.kind === 'session') source.attach(binding.session, floor, agent)
    else if (binding.kind === 'address') {
      source.attachFeed(new AddressConversationFeed(this.options.history(), binding.address, () => {
        if (this.displayed === id) this.transcript.refresh()
      }), floor)
    } else source.attach(null)
    // Recovery leases are shared per exact Agent, so the current one costs nothing extra.
    const release = agent === undefined ? () => {} : watchAssistantStream(this.ctx, agent)
    this.slots.set(id, { binding, floor, headed, source, release })
    this.transcript.setView(id, () => source.snapshot(), headed ? this.options.headed : undefined)
  }

  private drop(id: string): void {
    const slot = this.slots.get(id)!
    this.slots.delete(id)
    this.transcript.dropView(id)
    slot.release()
    slot.source.dispose()
  }
}
