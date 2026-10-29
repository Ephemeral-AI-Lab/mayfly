/** Safe turn retraction guarded by a native projection and committed turn close. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import { z } from 'zod'
import { resolveExactAgent } from './session.ts'

interface OpenTurn {
  readonly turn: number
  readonly startSeq: number
  readonly step: number
  readonly messageIds: readonly string[]
  readonly toolActivity: boolean
}

/** Current open-turn retraction facts, derived without a second Session log read. */
export interface MayflyRetractionState {
  readonly open: OpenTurn | null
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    /** Current open-turn message and tool-activity guard state. */
    mayflyRetraction: SessionProjectionSummaryExcluded<MayflyRetractionState>
  }
}

const stateSchema: z.ZodType<MayflyRetractionState> = z.object({
  open: z.object({
    turn: z.number().int().nonnegative(),
    startSeq: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    messageIds: z.array(z.string()),
    toolActivity: z.boolean(),
  }).nullable(),
})

function foldRetraction(state: MayflyRetractionState, event: SessionEvent): MayflyRetractionState {
  switch (event.type) {
    case 'turn/start':
      return { open: { turn: event.data.turn, startSeq: event.seq, step: 0, messageIds: [], toolActivity: false } }
    case 'step/start':
      return state.open?.turn === event.data.turn ? { open: { ...state.open, step: event.data.step } } : state
    case 'turn/end':
      return state.open?.turn === event.data.turn ? { open: null } : state
    case 'user/message':
      return state.open !== null && event.data.source.kind === 'user'
        ? { open: { ...state.open, messageIds: [...state.open.messageIds, String(event.data.id)] } }
        : state
    case 'tool/call':
    case 'tool/result':
      return state.open?.turn === event.data.turn ? { open: { ...state.open, toolActivity: true } } : state
    case 'assistant/message':
      return state.open?.turn === event.data.turn && event.data.message.content.some(block => block.type === 'tool-call')
        ? { open: { ...state.open, toolActivity: true } }
        : state
    default:
      return state
  }
}

type RetractionProjectionDefinition = Omit<ProjectionDefinition<'mayflyRetraction', MayflyRetractionState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'mayflyRetraction', MayflyRetractionState>['wire']>
}

/** Native open-turn projection used by the retraction guard. */
export const mayflyRetractionProjectionDefinition: RetractionProjectionDefinition = {
  key: 'mayflyRetraction',
  stateSchema,
  init: () => ({ open: null }),
  apply: foldRetraction,
  wire: { viewSchema: stateSchema, summary: false, view: state => state },
  stateVersion: 1,
}

interface PendingRetraction extends OpenTurn {
  readonly session: Session
}

/** Service-owned pending retraction coordinator. */
export class RetractionCoordinator {
  private readonly pending = new WeakMap<Agent, PendingRetraction>()
  private active = true

  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      for (const agent of [ctx.agents.get(session.id)]) {
        if (agent === undefined) continue
        const entry = this.pending.get(agent)
        if (entry === undefined || entry.session !== session || entry.turn !== event.data.turn) continue
        this.pending.delete(agent)
        this.persist(entry, event.seq)
      }
    })
    ctx.on('agent/disposed', ({ agent }) => { this.pending.delete(agent) })
    ctx.effect(() => () => { this.active = false })
  }

  private persist(entry: PendingRetraction, endSeq: number): void {
    queueMicrotask(() => {
      if (!this.active) return
      const nodes = entry.session.surface.nodes.filter(seq => seq > entry.startSeq && seq < endSeq)
      if (nodes.length === 0) return
      try {
        entry.session.append('developer/message', {
          turn: entry.turn,
          step: entry.step,
          message: createDeveloperMessage({ content: [], source: { kind: 'mayfly-retraction' } }),
        }, {
          surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! },
          sourceEventSeqs: nodes,
        })
      } catch (error) {
        this.ctx.logger.warn(`mayfly-host: could not persist turn retraction: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** Cancel only a matching tool-free running turn; persistence follows its authoritative close. */
  tryRetract(agent: Agent, messageId: string): boolean {
    if (!this.active || agent.status !== 'running' || this.pending.has(agent)) return false
    const open = this.ctx.sessionProjections.snapshot(agent.session, ['mayflyRetraction']).values.mayflyRetraction?.open
    if (open === undefined || open === null || open.toolActivity || !open.messageIds.includes(messageId)) return false
    this.pending.set(agent, { ...open, session: agent.session })
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }
}

/** Resolve the exact Session/Agent before applying the retraction guard. */
export async function retractTurn(ctx: Context, coordinator: RetractionCoordinator, sessionId: SessionId, messageId: string, signal: AbortSignal): Promise<boolean> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  return coordinator.tryRetract(agent, messageId)
}
