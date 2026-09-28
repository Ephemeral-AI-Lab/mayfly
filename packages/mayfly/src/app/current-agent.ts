/** Current raw dsh Agent selected by the Mayfly frontend tree.
 * @module @ephemeral-ai/mayfly/app/current-agent
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyConversationsService } from './conversation-views.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyCurrentAgent: MayflyCurrentAgentService }
}

/**
 * Exact Agent selection derived from the displayed conversation: the live
 * Agent an interactive conversation drives, or null while a readonly or
 * resumable one is displayed. Agent behavior stays native.
 */
export class MayflyCurrentAgentService extends Service {
  private selected: Agent | null = null
  private currentRevision = 0
  private readonly listeners = new Set<(agent: Agent | null, revision: number) => void>()

  constructor(ctx: Context, private readonly conversations: MayflyConversationsService) {
    super(ctx, 'mayflyCurrentAgent')
    conversations.subscribe(() => { this.sync() })
    ctx.effect(() => () => {
      this.selected = null
      this.listeners.clear()
    })
  }

  /** Exact live Agent, or null when the displayed conversation has none to drive. */
  current(): Agent | null {
    this.sync()
    return this.selected
  }

  /** Exact live primary Agent, or null after its registry identity vanished. */
  primary(): Agent | null {
    return this.conversations.primary()
  }

  /** Monotonic selection revision. */
  revision(): number { return this.currentRevision }

  /** Replay and observe exact Agent selection changes. */
  subscribe(listener: (agent: Agent | null, revision: number) => void): () => void {
    this.listeners.add(listener)
    listener(this.current(), this.currentRevision)
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  private sync(): void {
    const agent = this.conversations.displayedAgent()
    if (agent === this.selected) return
    this.selected = agent
    this.currentRevision += 1
    for (const listener of this.listeners) listener(agent, this.currentRevision)
  }
}
