/**
 * The Agents view's lifecycle: its members follow the displayed parent's facts and child states with no read of the tree,
 * and the native tree is read once a second only while the view is entered with a subagent still working, because each
 * read opens a follow per live child. Enter and stop are the same calls `/agents` makes.
 * @module @ephemeral-ai/mayfly/app/operations/agents-view
 */

import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import type { ConversationFacts } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyPaneRegistration, MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { MayflySubagentTreeEntry } from '../../hosts/host-contract.ts'
import type { SpawnedChildren } from '../../transcript/tool-calls.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { agentMembers, agentsLive, agentsPanel, agentsSummary, AGENTS_VIEW_LIST_ID, AGENTS_VIEW_STOP_ID, type AgentMember } from '../panels/agents.ts'

const VIEW_ID = 'mayfly.view.agents'
const POLL_MS = 1_000

type StopBlocked = NonNullable<Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>['stopBlocked']>

/** The calls the view shares with `/agents`, and the child states it shares with the stream. */
export interface AgentsViewSeam {
  /** The native tree, absent when no Session is selected. */
  tree(signal: AbortSignal): Promise<readonly MayflySubagentTreeEntry[] | undefined>
  stop(id: string, signal: AbortSignal): Promise<MayflyUiActionReply>
  open(id: string, signal: AbortSignal): Promise<MayflyUiActionReply>
  blocked(reason: StopBlocked): string
  children(): SpawnedChildren | undefined
  subscribeChildren(listener: () => void): () => void
}

class RemoteAgentsViewController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly pane: MayflyPaneRegistration
  private readonly offChildren: () => void
  private readonly offViews: () => void
  private offFacts: (() => void) | undefined
  private reads = new AbortController()
  private calls: ConversationFacts['agentCalls'] = []
  private members: readonly AgentMember[] = []
  private tree: readonly MayflySubagentTreeEntry[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private readingGeneration: number | undefined
  private entered = false
  private disposed = false

  constructor(private readonly options: RemoteFeatureContext, private readonly seam: AgentsViewSeam) {
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-operations-agents').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.pane = options.ctx.mayflyPanes.register({ id: VIEW_ID, placement: 'views', priority: 11, onEvent: { action: this.act } }, null)
    this.offChildren = seam.subscribeChildren(this.publish)
    this.offViews = options.screen.views.subscribe(this.followViews)
    this.lifecycle.start()
    this.followViews()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.reads.abort()
    this.offFacts?.()
    this.offChildren()
    this.offViews()
    this.stopPolling()
    this.pane.dispose()
  }

  private readonly attach = (generation: number): void => {
    this.reads.abort()
    this.reads = new AbortController()
    this.offFacts?.()
    this.offFacts = undefined
    this.calls = []
    this.tree = []
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const facts = current.binding.session.projections.faceOf('mayflyConversationFacts')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        this.calls = (facts.getSnapshot() as ConversationFacts | undefined)?.agentCalls ?? []
        this.publish()
      }
      this.offFacts = facts.subscribe(update)
      update()
    }
    this.publish()
    if (this.entered) void this.read()
  }

  private readonly followViews = (): void => {
    const views = this.options.screen.views
    const entered = views.isEntered && views.active === VIEW_ID
    if (entered === this.entered) return
    this.entered = entered
    if (entered) void this.read()
    this.syncPolling()
  }

  private syncPolling(): void {
    const wanted = this.entered && agentsLive(this.members)
    if (wanted && this.timer === undefined) {
      this.timer = setInterval(() => { void this.read() }, POLL_MS)
      this.timer.unref()
    } else if (!wanted) this.stopPolling()
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One read of the tree, kept for the figures. A failed read keeps the last one: the rows still have their members. */
  private async read(): Promise<void> {
    const generation = this.lifecycle.currentGeneration()
    if (this.readingGeneration === generation) return
    this.readingGeneration = generation
    const signal = this.reads.signal
    let next: readonly MayflySubagentTreeEntry[] | undefined
    try { next = await this.seam.tree(signal) } catch { /* The last readable tree stands until the next read. */ }
    if (this.readingGeneration === generation) this.readingGeneration = undefined
    if (!this.lifecycle.owns(generation)) return
    if (next !== undefined) this.tree = next
    this.publish()
  }

  private readonly blockedText = (entry: Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }> | undefined, member: AgentMember): string | undefined => {
    if (entry?.stopBlocked !== undefined) return this.seam.blocked(entry.stopBlocked)
    return member.state === 'running' ? undefined : this.seam.blocked('not-live')
  }

  private readonly publish = (): void => {
    if (this.disposed) return
    this.members = agentMembers(this.calls, this.seam.children())
    this.pane.setSummary(agentsSummary(this.members, this.t))
    this.pane.set(agentsPanel(this.members, this.tree, this.blockedText, Date.now(), this.t))
    this.syncPolling()
  }

  private readonly act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    if (this.disposed || context.signal.aborted) return { kind: 'cancelled' }
    if (event.kind === 'selection-accept' && event.controlId === AGENTS_VIEW_LIST_ID) {
      const id = event.selectedIds[0]
      return id === undefined ? { kind: 'completed' } : await this.seam.open(id, context.signal)
    }
    if (event.kind !== 'activate' || event.actionId !== AGENTS_VIEW_STOP_ID) return { kind: 'completed' }
    const id = event.inputs?.selections?.find(selection => selection.controlId === AGENTS_VIEW_LIST_ID)?.selectedIds[0]
    if (id === undefined) return { kind: 'completed' }
    const reply = await this.seam.stop(id, context.signal)
    if (reply.kind === 'completed') void this.read()
    return reply
  }
}

/**
 * Mount the Agents view.
 * @param options - the feature context.
 * @param seam - the calls it shares with `/agents` and the stream.
 * @returns the disposer, which retires its reads, its timer, and its pane.
 */
export function mountAgentsView(options: RemoteFeatureContext, seam: AgentsViewSeam): () => void {
  return new RemoteAgentsViewController(options, seam).dispose
}
