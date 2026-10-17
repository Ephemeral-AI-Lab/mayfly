/**
 * Renderer-neutral bridge from the official conversation-facts projection to
 * status and dock consumers. It owns only the current renderer-neutral session
 * Agent selection and immutable whole-value projection facts.
 *
 * @module @ephemeral-ai/mayfly/transcript/session-facts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalProjection } from '@deepseek-ai/dsh-goal'
import { isSpawnToolName } from '../conversation/projection.ts'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title/types'
import type { LiveAssistantDraft, LiveAssistantStreamService } from '../conversation/live-stream.ts'
import type { ConversationFacts, OutputProgress } from '../conversation/types.ts'
import { initialConversationFacts } from '../conversation/facts.ts'

/** Renderer-neutral facts for one admitted child session. */
export interface ChildSessionFacts {
  readonly id: string
  readonly promptText?: string | undefined
  readonly phase: 'waiting' | 'running' | 'completed' | 'failed'
  readonly tokens: number
  /** The run's tokens split: input (cache included) and output, settled steps only. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCount: number
  /** Streamed output chars of the live attempt; undefined once it settles. */
  readonly liveChars?: number | undefined
  /** The live attempt's output progress, for the token rate. */
  readonly outputProgress?: OutputProgress | undefined
  readonly activity?: string | undefined
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly endedAt?: number | undefined
  /** A `failed` run that was stopped (by the user) rather than one that failed on its own. */
  readonly stopped?: boolean | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context { mayflySessionFacts: SessionFactsService }
}

/**
 * Children whose only change is the streamed-character count republish on
 * this trailing cadence; every other child change publishes at once. The
 * Agents item repaints its volatile counters on the same cadence.
 */
export const CHILD_VOLATILE_MS = 250

/** One admitted child: its facts, its resident Agent, its current draft, and their projection. */
interface ChildRecord {
  readonly facts: ConversationFacts
  /** The exact Agent the child session is resident in, kept across live notifications. */
  readonly agent: Agent | undefined
  readonly draft: LiveAssistantDraft | undefined
  readonly projected: ChildSessionFacts
}

/** How many settled children stay in the list: the Agents panel shows one line per child, and 32 covers a tall terminal. */
export const MAX_SETTLED_CHILDREN = 32

/** Whether one output-progress value carries the same figures. */
function sameOutputProgress(previous: ChildSessionFacts['outputProgress'], next: ChildSessionFacts['outputProgress']): boolean {
  return previous === next || (previous !== undefined && next !== undefined
    && previous.chars === next.chars
    && previous.initialChars === next.initialChars
    && previous.startedAt === next.startedAt
    && previous.updatedAt === next.updatedAt)
}

/** Whether two projections of one child carry the same values in every field. */
function equalChildSessionFacts(previous: ChildSessionFacts, next: ChildSessionFacts): boolean {
  return previous === next || (previous.id === next.id
    && previous.promptText === next.promptText
    && previous.phase === next.phase
    && previous.tokens === next.tokens
    && previous.inputTokens === next.inputTokens
    && previous.outputTokens === next.outputTokens
    && previous.toolCount === next.toolCount
    && previous.liveChars === next.liveChars
    && sameOutputProgress(previous.outputProgress, next.outputProgress)
    && previous.activity === next.activity
    && previous.model === next.model
    && previous.effort === next.effort
    && previous.endedAt === next.endedAt
    && previous.stopped === next.stopped)
}

/** Whether a child's projection changed only in the live attempt's streamed output (its chars and progress). */
function onlyLiveOutputChanged(previous: ChildSessionFacts, next: ChildSessionFacts): boolean {
  return (previous.liveChars !== next.liveChars || !sameOutputProgress(previous.outputProgress, next.outputProgress))
    && previous.id === next.id
    && previous.promptText === next.promptText
    && previous.phase === next.phase
    && previous.tokens === next.tokens
    && previous.inputTokens === next.inputTokens
    && previous.outputTokens === next.outputTokens
    && previous.toolCount === next.toolCount
    && previous.activity === next.activity
    && previous.model === next.model
    && previous.effort === next.effort
    && previous.endedAt === next.endedAt
    && previous.stopped === next.stopped
}

/** What a fresh projection means for the publish cadence. */
function childChange(previous: ChildSessionFacts, next: ChildSessionFacts): 'same' | 'volatile' | 'structural' {
  if (equalChildSessionFacts(previous, next)) return 'same'
  return onlyLiveOutputChanged(previous, next) ? 'volatile' : 'structural'
}

/** Whether a child's run is still live, which keeps it however many settled children the list holds. */
function isLiveChild(facts: ChildSessionFacts): boolean {
  return facts.phase === 'waiting' || facts.phase === 'running'
}

/**
 * The live draft's activity: the latest reasoning paragraph while thinking,
 * text while composing, and while waiting the newest call whose arguments are
 * still streaming, else the durable marker.
 */
function draftActivity(draft: LiveAssistantDraft, durable: ConversationFacts['activity']): ConversationFacts['activity'] {
  if (draft.phase === 'thinking') return { kind: 'reasoning' }
  if (draft.phase === 'composing') return { kind: 'text' }
  const preparing = draft.preparing?.at(-1)
  return preparing === undefined ? durable : { kind: 'tool', name: preparing.name, preparing: true }
}

/**
 * The calls in flight: the committed calls awaiting a result, then the calls whose arguments still stream in the draft
 * (a call the durable list already holds is committed, so it is not preparing). Spawn calls belong to the Agents item.
 */
function inFlightOf(draft: LiveAssistantDraft, durable: ConversationFacts): ConversationFacts['inFlight'] {
  const committed = durable.inFlight ?? []
  const preparing = (draft.preparing ?? [])
    .filter(call => !isSpawnToolName(call.name) && !committed.some(item => item.callId === call.id))
    .map(call => ({ callId: call.id, name: call.name, preparing: true }))
  return preparing.length === 0 ? durable.inFlight : [...committed, ...preparing]
}

/** Session-scoped facts bridge for status and dock model producers. */
export class SessionFactsService extends Service {
  private agent: Agent | null = null
  private durable: ConversationFacts = initialConversationFacts()
  private facts: ConversationFacts = initialConversationFacts()
  private live: LiveAssistantDraft | undefined
  private title: string | undefined
  private goal: GoalProjection | null = null
  private readonly listeners = new Set<(facts: ConversationFacts) => void>()
  private readonly titleListeners = new Set<(title: string | undefined) => void>()
  private readonly goalListeners = new Set<(goal: GoalProjection | null) => void>()
  private readonly agentListeners = new Set<(agent: Agent | null) => void>()
  private readonly childListeners = new Set<(children: readonly ChildSessionFacts[]) => void>()
  private readonly children = new Map<string, ChildRecord>()
  private childList: readonly ChildSessionFacts[] | undefined
  private volatileTimer: ReturnType<typeof setTimeout> | undefined
  private readonly offProjection: () => void
  private readonly offAgent: () => void
  private readonly offLive: () => void
  private readonly offAgentCreated: () => void
  private readonly offAgentDisposed: () => void

  constructor(ctx: Context, private readonly liveStream?: LiveAssistantStreamService) {
    super(ctx, 'mayflySessionFacts')
    this.offProjection = ctx.sessionProjections.onChanged((session, key, value) => {
      if (session === this.agent?.session) {
        if (key === 'mayflyConversationFacts' && isFacts(value)) this.publish(value)
        if (key === 'title' && isTitle(value)) this.publishTitle(value ?? undefined)
        if (key === 'goal' && isGoalProjection(value)) this.publishGoal(value)
        return
      }
      if (key === 'mayflyConversationFacts' && this.isDirectChild(session) && isFacts(value)) {
        this.publishChild(String(session.id), value)
      }
    })
    this.offAgent = ctx.mayflyCurrentAgent.subscribe(next => { this.attach(next) })
    // Harness `0.1.5` streams live deltas as transient Agent frames; the
    // durable facts projection settles only at attempt boundaries. The draft
    // overlays the streaming phase and output progress of the current Agent and
    // each admitted child, so reasoning children report Thinking… while their
    // durable facts still read waiting.
    this.offLive = liveStream === undefined
      ? () => {}
      : liveStream.subscribe(() => {
        const draft = this.agent === null ? undefined : liveStream.get(this.agent)
        if (draft !== this.live) {
          this.live = draft
          this.facts = this.merged()
          for (const listener of this.listeners) listener(this.facts)
        }
        // Only children whose draft identity changed re-project. An unchanged projection is no change; streamed output
        // alone waits for the volatile cadence; anything else publishes at once.
        let structural = false
        let volatile = false
        for (const [id, record] of this.children) {
          const next = this.draftOf(record)
          if (next === record.draft) continue
          const projected = projectChildSessionFacts(id, record.facts, next)
          const change = childChange(record.projected, projected)
          if (change === 'same') {
            this.children.set(id, { ...record, draft: next })
            continue
          }
          this.children.set(id, { ...record, draft: next, projected })
          this.childList = undefined
          if (change === 'volatile') volatile = true
          else structural = true
        }
        if (structural) {
          this.pruneChildren()
          this.publishChildren()
        } else if (volatile) this.scheduleChildren()
      })
    // A child's Agent may come or go without its session facts changing: an appeared Agent brings its draft, a disposed
    // one takes it away; a replaced Agent is followed. The live path above never reads the registry again.
    this.offAgentCreated = ctx.on('agent/created', ({ agent }) => { this.refreshChildAgent(agent) })
    this.offAgentDisposed = ctx.on('agent/disposed', ({ agent }) => { this.forgetChildAgent(agent) })
  }

  /** Current facts; the returned object is projection-owned readonly data. */
  get current(): ConversationFacts {
    return this.facts
  }

  /** Current official session title, when the title projection is available. */
  get currentTitle(): string | undefined {
    return this.title
  }

  /** Current official goal projection value, or null without a current goal. */
  get currentGoal(): GoalProjection | null {
    return this.goal
  }

  /** Current raw dsh Agent selected by Mayfly. */
  get currentAgent(): Agent | null { return this.agent }

  /** Subscribe to whole-value changes; the current value is delivered first. */
  subscribe(listener: (facts: ConversationFacts) => void): () => void {
    this.listeners.add(listener)
    listener(this.facts)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to title-projection changes; the current value is delivered first. */
  subscribeTitle(listener: (title: string | undefined) => void): () => void {
    this.titleListeners.add(listener)
    listener(this.title)
    return () => this.titleListeners.delete(listener)
  }

  /** Subscribe to goal-projection changes; the current value is delivered first. */
  subscribeGoal(listener: (goal: GoalProjection | null) => void): () => void {
    this.goalListeners.add(listener)
    listener(this.goal)
    return () => this.goalListeners.delete(listener)
  }

  /** Subscribe to exact current-Agent changes. */
  subscribeAgent(listener: (agent: Agent | null) => void): () => void {
    this.agentListeners.add(listener)
    listener(this.agent)
    return () => this.agentListeners.delete(listener)
  }

  /** Subscribe to projection-backed child-session run facts for the active parent. */
  subscribeChildren(listener: (children: readonly ChildSessionFacts[]) => void): () => void {
    this.childListeners.add(listener)
    listener(this.childrenForCurrentSession())
    return () => this.childListeners.delete(listener)
  }

  /** Attach the service to the exact selected Agent. */
  attach(agent: Agent | null): void {
    const switched = this.agent !== agent
    this.agent = agent
    for (const listener of this.agentListeners) listener(agent)
    if (!switched) return

    this.live = agent === null ? undefined : this.liveStream?.get(agent)
    this.cancelChildren()
    this.children.clear()
    this.childList = undefined
    const snapshot = agent === null
      ? undefined
      : this.ctx.sessionProjections.snapshot(agent.session, ['mayflyConversationFacts', 'title', 'goal'])
    const facts = snapshot?.values.mayflyConversationFacts
    this.publish(isFacts(facts) ? facts : initialConversationFacts())
    const title = snapshot?.values.title
    this.publishTitle(isTitle(title) ? title ?? undefined : undefined)
    const goal = snapshot?.values.goal
    this.publishGoal(isGoalProjection(goal) ? goal : null)
    for (const child of this.directChildren()) {
      const childFacts = this.ctx.sessionProjections.snapshot(child, ['mayflyConversationFacts']).values.mayflyConversationFacts
      if (isFacts(childFacts)) this.setChild(String(child.id), childFacts)
    }
    this.pruneChildren()
    this.publishChildren()
  }

  dispose(): void {
    this.offProjection()
    this.offAgent()
    this.offLive()
    this.offAgentCreated()
    this.offAgentDisposed()
    this.listeners.clear()
    this.titleListeners.clear()
    this.goalListeners.clear()
    this.agentListeners.clear()
    this.childListeners.clear()
    this.cancelChildren()
    this.children.clear()
    this.childList = undefined
    this.agent = null
    this.durable = initialConversationFacts()
    this.facts = initialConversationFacts()
    this.live = undefined
    this.title = undefined
    this.goal = null
  }

  /** Durable facts overlaid with the current Agent's live streaming draft. */
  private merged(): ConversationFacts {
    const draft = this.live
    if (draft === undefined || this.agent === null || draft.sessionId !== String(this.agent.session.id)) return this.durable
    if (draft.turn < this.durable.turn || (draft.turn === this.durable.turn
      && (this.durable.runOutcome !== undefined
        || (this.durable.currentStep !== undefined && draft.step < this.durable.currentStep)
        || (this.durable.lastCompletedStep !== undefined && draft.step <= this.durable.lastCompletedStep)))) return this.durable
    return {
      ...this.durable,
      active: true,
      turn: draft.turn,
      currentStep: draft.step,
      phase: draft.phase,
      activity: draftActivity(draft, this.durable.activity),
      inFlight: inFlightOf(draft, this.durable),
      flowDownChars: this.durable.flowDownChars + draft.chars,
      outputProgress: draft.outputProgress,
    }
  }

  private publish(next: ConversationFacts): void {
    this.durable = next
    const merged = this.merged()
    if (merged === this.facts) return
    this.facts = merged
    for (const listener of this.listeners) listener(merged)
  }

  private publishTitle(next: string | undefined): void {
    if (next === this.title) return
    this.title = next
    for (const listener of this.titleListeners) listener(next)
  }

  private publishGoal(next: GoalProjection | null): void {
    if (next === this.goal) return
    this.goal = next
    for (const listener of this.goalListeners) listener(next)
  }

  private publishChild(id: string, facts: ConversationFacts): void {
    const previous = this.children.get(id)
    const agent = previous?.agent ?? this.agentFor(id)
    const draft = this.draftFor(agent)
    const projected = projectChildSessionFacts(id, facts, draft)
    if (previous !== undefined) {
      const change = childChange(previous.projected, projected)
      if (change === 'same') {
        this.children.set(id, { facts, agent, draft, projected: previous.projected })
        return
      }
      this.children.set(id, { facts, agent, draft, projected })
      this.childList = undefined
      if (change === 'volatile') {
        this.scheduleChildren()
        return
      }
    } else {
      this.children.set(id, { facts, agent, draft, projected })
      this.childList = undefined
    }
    this.pruneChildren()
    this.publishChildren()
  }

  private setChild(id: string, facts: ConversationFacts): void {
    const agent = this.agentFor(id)
    const draft = this.draftFor(agent)
    this.children.set(id, { facts, agent, draft, projected: projectChildSessionFacts(id, facts, draft) })
    this.childList = undefined
  }

  /** Follow an Agent that appeared for one of the children: its draft joins the projection. */
  private refreshChildAgent(agent: Agent): void {
    const id = String(agent.id)
    const record = this.children.get(id)
    if (record === undefined) return
    this.updateChildAgent(id, record, agent)
  }

  /** Drop the draft of a child whose exact resident Agent was disposed; a replaced Agent's disposal is not its own. */
  private forgetChildAgent(agent: Agent): void {
    const id = String(agent.id)
    const record = this.children.get(id)
    if (record === undefined || record.agent !== agent) return
    this.updateChildAgent(id, record, undefined)
  }

  private updateChildAgent(id: string, record: ChildRecord, agent: Agent | undefined): void {
    const draft = this.draftFor(agent)
    const projected = projectChildSessionFacts(id, record.facts, draft)
    const change = childChange(record.projected, projected)
    if (change === 'same') {
      this.children.set(id, { ...record, agent, draft })
      return
    }
    this.children.set(id, { ...record, agent, draft, projected })
    this.childList = undefined
    if (change === 'volatile') {
      this.scheduleChildren()
      return
    }
    this.pruneChildren()
    this.publishChildren()
  }

  /** Keep every live child plus the most recently settled ones; an old settled child is dropped first. */
  private pruneChildren(): void {
    const settled = [...this.children].filter(([, record]) => !isLiveChild(record.projected))
    if (settled.length <= MAX_SETTLED_CHILDREN) return
    settled.sort((left, right) => (left[1].projected.endedAt ?? 0) - (right[1].projected.endedAt ?? 0))
    for (const [id] of settled.slice(0, settled.length - MAX_SETTLED_CHILDREN)) this.children.delete(id)
    this.childList = undefined
  }

  /** Publish now; any pending volatile republish is subsumed. */
  private publishChildren(): void {
    this.cancelChildren()
    const children = this.childrenForCurrentSession()
    for (const listener of this.childListeners) listener(children)
  }

  /** Coalesce streamed-character-only changes into one trailing publish. */
  private scheduleChildren(): void {
    if (this.volatileTimer !== undefined) return
    this.volatileTimer = setTimeout(() => {
      this.volatileTimer = undefined
      this.publishChildren()
    }, CHILD_VOLATILE_MS)
    this.volatileTimer.unref()
  }

  private cancelChildren(): void {
    if (this.volatileTimer === undefined) return
    clearTimeout(this.volatileTimer)
    this.volatileTimer = undefined
  }

  private childrenForCurrentSession(): readonly ChildSessionFacts[] {
    this.childList ??= [...this.children.values()].map(record => record.projected)
    return this.childList
  }

  /** Latest transient stream draft for a child's stored resident Agent. */
  private draftOf(record: ChildRecord): LiveAssistantDraft | undefined {
    return this.draftFor(record.agent)
  }

  private draftFor(agent: Agent | undefined): LiveAssistantDraft | undefined {
    return agent === undefined ? undefined : this.liveStream?.get(agent)
  }

  /** The child session's resident Agent, read once when the record is set or its lifecycle changes. */
  private agentFor(id: string): Agent | undefined {
    return this.ctx.get('agents')?.get(SessionId(id))
  }

  private directChildren(): readonly Session[] {
    const parent = this.agent
    if (parent === null) return []
    return [...this.ctx.sessions.list()].filter(session => this.isDirectChild(session))
  }

  private isDirectChild(session: Session): boolean {
    const parent = this.agent
    return parent !== null
      && session.header.origin === 'subagent'
      && session.header.parentSession === parent.id
  }
}

/** Convert one child session's official facts to renderer-neutral card facts. */
export function projectChildSessionFacts(id: string, facts: ConversationFacts, draft?: LiveAssistantDraft): ChildSessionFacts {
  const liveDraft = draft !== undefined && draft.sessionId === id
    && !(draft.turn < facts.turn || (draft.turn === facts.turn
      && (facts.runOutcome !== undefined
        || (facts.currentStep !== undefined && draft.step < facts.currentStep)
        || (facts.lastCompletedStep !== undefined && draft.step <= facts.lastCompletedStep))))
    ? draft : undefined
  const phase = facts.active
    ? liveDraft !== undefined && liveDraft.phase !== 'waiting' ? 'running' : facts.phase === 'waiting' ? 'waiting' : 'running'
    // A child whose first turn has not begun has no outcome yet: it is about to work, not finished.
    : facts.runOutcome ?? 'waiting'
  const marker = facts.activity
  const activity = liveDraft !== undefined && liveDraft.phase !== 'waiting'
    ? liveDraft.phase === 'thinking' ? 'Thinking…' : 'Writing…'
    : marker?.kind === 'tool'
      ? `Using ${marker.name ?? 'tool'}`
      : marker?.kind === 'reasoning'
        ? 'Thinking…'
        : marker?.kind === 'text' ? 'Writing…' : facts.active ? 'Starting…' : undefined
  return {
    id, phase, tokens: facts.epochTokens ?? 0, toolCount: facts.epochToolCount ?? 0,
    inputTokens: Math.max(0, (facts.epochTokens ?? 0) - (facts.epochOutputTokens ?? 0)), outputTokens: facts.epochOutputTokens ?? 0,
    ...(liveDraft !== undefined && liveDraft.chars > 0 ? { liveChars: liveDraft.chars } : {}),
    ...(liveDraft?.outputProgress === undefined ? {} : { outputProgress: liveDraft.outputProgress }),
    ...(facts.promptText === undefined ? {} : { promptText: facts.promptText }),
    ...(activity === undefined ? {} : { activity }),
    ...(facts.model === undefined ? {} : { model: facts.model }),
    ...(facts.reasoningEffort === undefined ? {} : { effort: facts.reasoningEffort }),
    ...(facts.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
    ...(facts.runStopped === true ? { stopped: true } : {}),
  }
}

function isFacts(value: unknown): value is ConversationFacts {
  if (value === null || typeof value !== 'object') return false
  const row = value as { phase?: unknown, active?: unknown, turn?: unknown, flowDownChars?: unknown, todos?: unknown, contextTokens?: unknown, agentCalls?: unknown }
  return (row.phase === 'idle' || row.phase === 'waiting' || row.phase === 'thinking' || row.phase === 'composing' || row.phase === 'tool')
    && typeof row.active === 'boolean'
    && typeof row.turn === 'number'
    && typeof row.flowDownChars === 'number'
    && Array.isArray(row.todos)
    && typeof row.contextTokens === 'number'
    && Array.isArray(row.agentCalls)
}

function isTitle(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isGoalProjection(value: unknown): value is GoalProjection | null {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const row = value as { goal?: unknown, roundsStarted?: unknown, createdAt?: unknown, updatedAt?: unknown }
  if (typeof row.roundsStarted !== 'number' || typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') return false
  if (row.goal === null || typeof row.goal !== 'object') return false
  const goal = row.goal as { id?: unknown, revision?: unknown, objective?: unknown, phase?: unknown, blockedReason?: unknown, maxGoalRounds?: unknown }
  if (typeof goal.id !== 'string' || typeof goal.revision !== 'number' || typeof goal.objective !== 'string') return false
  if (goal.phase !== 'active' && goal.phase !== 'paused' && goal.phase !== 'blocked' && goal.phase !== 'complete') return false
  if (typeof goal.maxGoalRounds !== 'number') return false
  if (goal.blockedReason !== undefined) {
    if (goal.blockedReason === null || typeof goal.blockedReason !== 'object') return false
    const reason = goal.blockedReason as { code?: unknown, message?: unknown }
    if (typeof reason.code !== 'string' || typeof reason.message !== 'string') return false
  }
  return true
}
