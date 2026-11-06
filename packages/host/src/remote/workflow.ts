/** Durable Workflow baselines and process-local live metadata for replacement streams. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import { RemoteError, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import type { WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'
import { z } from 'zod'
import type { MayflyWorkflowAgent, MayflyWorkflowFrame, MayflyWorkflowRun, MayflyWorkflowSnapshot } from '../types.ts'
import { frozen } from './json.ts'
import { ChangeQueue } from './queue.ts'
import { requireExactAgent, resolveExactAgent } from './session.ts'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    /** Complete current Workflow runs for one parent Session. */
    mayflyWorkflow: SessionProjectionSummaryExcluded<MayflyWorkflowSnapshot>
  }
}

const sessionIdSchema = z.custom<SessionId>(value => typeof value === 'string' && value.length > 0)
const agentSchema = z.object({
  seq: z.number().int().positive(),
  label: z.string(),
  phase: z.string().optional(),
  childId: sessionIdSchema,
  outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
  interrupted: z.literal(true).optional(),
})
const workflowPhaseSchema: z.ZodType<WorkflowPhase> = z.object({
  title: z.string(),
  detail: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
}).transform(({ title, detail, provider, model }) => ({
  title,
  ...detail === undefined ? {} : { detail },
  ...provider === undefined ? {} : { provider },
  ...model === undefined ? {} : { model },
}))
const runSchema = z.object({
  id: z.string(),
  name: z.string(),
  phases: z.array(workflowPhaseSchema).optional(),
  phasesSeen: z.array(z.string()),
  currentPhase: z.string().optional(),
  agents: z.array(agentSchema),
  startedAt: z.number(),
  stopReason: z.enum(['completed', 'cancelled', 'error']).optional(),
  endedAt: z.number().optional(),
  agentsStarted: z.number().int().nonnegative().optional(),
  interrupted: z.literal(true).optional(),
})

/** Runtime schema for one complete Workflow snapshot. */
export const mayflyWorkflowSnapshotSchema: z.ZodType<MayflyWorkflowSnapshot> = z.object({
  sessionId: sessionIdSchema,
  runs: z.array(runSchema),
})

function withoutRunInterruption(run: MayflyWorkflowRun): MayflyWorkflowRun {
  if (run.interrupted !== true) return run
  const { interrupted, ...rest } = run
  void interrupted
  return rest
}

function withoutAgentInterruption(agent: MayflyWorkflowAgent): MayflyWorkflowAgent {
  if (agent.interrupted !== true) return agent
  const { interrupted, ...rest } = agent
  void interrupted
  return rest
}

function updateRun(state: MayflyWorkflowSnapshot, id: string, update: (run: MayflyWorkflowRun) => MayflyWorkflowRun): MayflyWorkflowSnapshot {
  const index = state.runs.findIndex(run => run.id === id)
  if (index < 0) return state
  const runs = [...state.runs]
  runs[index] = update(runs[index]!)
  return frozen({ ...state, runs })
}

/** How long a settled run survives a new turn: at least the hold of the TUI's Workflow view. */
const SETTLED_RUN_KEEP_MS = 10_000

function interruptRuns(state: MayflyWorkflowSnapshot, time: number): MayflyWorkflowSnapshot {
  let changed = false
  const runs = state.runs.map((run): MayflyWorkflowRun => {
    if (run.stopReason !== undefined || run.interrupted === true) return run
    changed = true
    return {
      ...run,
      agents: run.agents.map(agent => agent.outcome === undefined ? { ...agent, interrupted: true as const } : agent),
      endedAt: time,
      interrupted: true,
    }
  })
  return changed ? frozen({ ...state, runs }) : state
}

function foldWorkflow(state: MayflyWorkflowSnapshot, event: SessionEvent): MayflyWorkflowSnapshot {
  switch (event.type) {
    case 'turn/start': {
      // A killed background run starts a turn at once; its view still shows how it ended for a moment.
      const runs = state.runs.filter(run => (run.stopReason === undefined && run.interrupted !== true) || event.time - (run.endedAt ?? 0) < SETTLED_RUN_KEEP_MS)
      return runs.length === state.runs.length ? state : frozen({ ...state, runs })
    }
    case 'turn/end':
      return event.data.reason.kind === 'interrupted' || event.data.reason.kind === 'forked'
        ? interruptRuns(state, event.time)
        : state
    case 'session/end-seed':
      return interruptRuns(state, event.time)
    case 'tool-workflow/run-start': {
      const id = String(event.data.runId)
      if (state.runs.some(run => run.id === id)) return state
      return frozen({
        ...state,
        runs: [...state.runs, {
          id,
          name: event.data.name,
          phasesSeen: [],
          agents: [],
          startedAt: event.time,
        }],
      })
    }
    case 'tool-workflow/agent-start':
      return updateRun(state, String(event.data.runId), run => {
        const seq = event.data.seq
        const agents = run.agents.filter(agent => agent.seq !== seq)
        const phasesSeen = event.data.phase !== undefined && !run.phasesSeen.includes(event.data.phase)
          ? [...run.phasesSeen, event.data.phase]
          : run.phasesSeen
        return {
          ...run,
          phasesSeen,
          ...event.data.phase === undefined ? {} : { currentPhase: event.data.phase },
          agents: [...agents, {
            seq,
            label: event.data.label,
            ...event.data.phase === undefined ? {} : { phase: event.data.phase },
            childId: event.data.childId,
          }],
        }
      })
    case 'tool-workflow/agent-end':
      return updateRun(state, String(event.data.runId), run => ({
        ...run,
        agents: run.agents.map(agent => agent.seq === event.data.seq
          ? withoutAgentInterruption({ ...agent, outcome: event.data.outcome })
          : agent),
      }))
    case 'tool-workflow/run-end':
      return updateRun(state, String(event.data.runId), run => ({
        ...withoutRunInterruption(run),
        stopReason: event.data.stopReason,
        endedAt: event.time,
      }))
    default:
      return state
  }
}

type WorkflowProjectionDefinition = Omit<ProjectionDefinition<'mayflyWorkflow', MayflyWorkflowSnapshot>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'mayflyWorkflow', MayflyWorkflowSnapshot>['wire']>
}

/** Native Session projection supplying complete durable Workflow baselines. */
export const mayflyWorkflowProjectionDefinition: WorkflowProjectionDefinition = {
  key: 'mayflyWorkflow',
  stateSchema: mayflyWorkflowSnapshotSchema,
  init: header => ({ sessionId: header.id, runs: [] }),
  apply: foldWorkflow,
  wire: {
    viewSchema: mayflyWorkflowSnapshotSchema,
    summary: false,
    view: state => state,
  },
  stateVersion: 2,
}

interface LiveRun {
  id: string
  parentSessionId: SessionId | undefined
  name: string
  phases?: MayflyWorkflowRun['phases']
  phasesSeen: string[]
  currentPhase?: string
  agents: MayflyWorkflowAgent[]
  startedAt: number
  stopReason?: MayflyWorkflowRun['stopReason']
  endedAt?: number
  agentsStarted?: number
  interrupted?: true
}

function mergeAgent(base: MayflyWorkflowAgent | undefined, live: MayflyWorkflowAgent): MayflyWorkflowAgent {
  const source = base ?? live
  const outcome = live.outcome ?? base?.outcome
  const merged = { ...source, ...live, ...outcome === undefined ? {} : { outcome } }
  if (outcome !== undefined) return withoutAgentInterruption(merged)
  return (live.interrupted ?? base?.interrupted) === true ? { ...merged, interrupted: true } : merged
}

function mergeRun(base: MayflyWorkflowRun | undefined, live: LiveRun): MayflyWorkflowRun {
  const source = base ?? live
  const stopReason = base?.stopReason ?? live.stopReason
  const agents = new Map<number, MayflyWorkflowAgent>()
  for (const agent of base?.agents ?? []) agents.set(agent.seq, agent)
  for (const agent of live.agents) agents.set(agent.seq, mergeAgent(agents.get(agent.seq), agent))
  const phasesSeen = [...new Set([...base?.phasesSeen ?? [], ...live.phasesSeen])]
  return {
    id: source.id,
    name: source.name,
    ...live.phases === undefined ? {} : { phases: live.phases },
    phasesSeen,
    ...(live.currentPhase ?? base?.currentPhase) === undefined ? {} : { currentPhase: live.currentPhase ?? base?.currentPhase },
    agents: [...agents.values()].toSorted((left, right) => left.seq - right.seq),
    startedAt: base?.startedAt ?? live.startedAt,
    ...stopReason === undefined ? {} : { stopReason },
    ...(base?.endedAt ?? live.endedAt) === undefined ? {} : { endedAt: base?.endedAt ?? live.endedAt },
    ...live.agentsStarted === undefined ? {} : { agentsStarted: live.agentsStarted },
    ...stopReason === undefined && (base?.interrupted ?? live.interrupted) === true ? { interrupted: true as const } : {},
  }
}

/** Service-owned live Workflow metadata; no process-global mutable product state. */
export class WorkflowLiveCatalog {
  private readonly runs = new Map<string, LiveRun>()
  private readonly listeners = new Set<(runId: string | undefined) => void>()

  constructor(private readonly ctx: Context) {
    ctx.on('workflow/start', info => {
      const run = this.ensure(info)
      run.name = info.meta.name
      run.phases = info.meta.phases?.map(phase => workflowPhaseSchema.parse(phase))
      run.startedAt = Date.now()
      this.emit(info)
    })
    ctx.on('workflow/phase', (info, title) => {
      const run = this.ensure(info)
      run.currentPhase = title
      if (!run.phasesSeen.includes(title)) run.phasesSeen.push(title)
      this.emit(info)
    })
    ctx.on('workflow/agent-start', (info, agent) => {
      const run = this.ensure(info)
      run.parentSessionId = this.ctx.sessions.get(agent.childId)?.header.parentSession ?? run.parentSessionId
      run.agents = [...run.agents.filter(member => member.seq !== agent.seq), {
        seq: agent.seq,
        label: agent.label,
        ...agent.phase === undefined ? {} : { phase: agent.phase },
        childId: agent.childId,
      }]
      if (agent.phase !== undefined) {
        run.currentPhase = agent.phase
        if (!run.phasesSeen.includes(agent.phase)) run.phasesSeen.push(agent.phase)
      }
      this.emit(info)
    })
    ctx.on('workflow/agent-end', (info, agent) => {
      const run = this.ensure(info)
      run.parentSessionId = this.ctx.sessions.get(agent.childId)?.header.parentSession ?? run.parentSessionId
      run.agents = run.agents.map(member => member.seq === agent.seq
        ? withoutAgentInterruption({ ...member, outcome: agent.outcome })
        : member)
      this.emit(info)
    })
    ctx.on('workflow/end', (info, result) => {
      const run = this.ensure(info)
      run.stopReason = result.stopReason
      run.endedAt = Date.now()
      run.agentsStarted = result.agentsStarted
      this.emit(info)
    })
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
  }

  private ensure(info: WorkflowRunInfo): LiveRun {
    const id = String(info.id)
    let run = this.runs.get(id)
    if (run === undefined) {
      run = { id, parentSessionId: undefined, name: info.meta.name, phasesSeen: [], agents: [], startedAt: Date.now() }
      this.runs.set(id, run)
    }
    return run
  }

  private emit(info: WorkflowRunInfo): void {
    this.publish(String(info.id))
  }

  private publish(runId: string | undefined): void {
    for (const listener of this.listeners) {
      try {
        listener(runId)
      } catch (error) {
        this.ctx.logger.warn(`mayfly-host: Workflow listener failed: ${String(error)}`)
      }
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      for (const run of this.runs.values()) {
        if (run.parentSessionId === session.id && (run.stopReason !== undefined || run.interrupted === true)) this.runs.delete(run.id)
      }
      this.publish(undefined)
      return
    }
    if (event.type === 'session/end-seed' || event.type === 'turn/end' && (event.data.reason.kind === 'interrupted' || event.data.reason.kind === 'forked')) {
      for (const run of this.runs.values()) {
        if (run.parentSessionId !== session.id || run.stopReason !== undefined || run.interrupted === true) continue
        run.agents = run.agents.map(agent => agent.outcome === undefined ? { ...agent, interrupted: true as const } : agent)
        run.endedAt = event.time
        run.interrupted = true
      }
      this.publish(undefined)
      return
    }
    if (event.type !== 'tool-workflow/run-start' && event.type !== 'tool-workflow/agent-start'
      && event.type !== 'tool-workflow/agent-end' && event.type !== 'tool-workflow/run-end') return
    const id = String(event.data.runId)
    const run = this.runs.get(id) ?? {
      id,
      parentSessionId: undefined,
      name: event.type === 'tool-workflow/run-start' ? event.data.name : '',
      phasesSeen: [],
      agents: [],
      startedAt: event.time,
    }
    run.parentSessionId = session.id
    this.runs.set(id, run)
    this.publish(id)
  }

  /** Observe live metadata changes; the caller owns the returned disposer. */
  subscribe(listener: (runId: string | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private baseline(ctx: Context, session: Session): MayflyWorkflowSnapshot {
    return mayflyWorkflowSnapshotSchema.parse(ctx.sessionProjections.snapshot(session, ['mayflyWorkflow']).values.mayflyWorkflow)
  }

  /** Whether one run belongs to this Session or is already in its durable baseline. */
  affects(ctx: Context, session: Session, runId: string): boolean {
    const run = this.runs.get(runId)
    return run?.parentSessionId === session.id || this.baseline(ctx, session).runs.some(candidate => candidate.id === runId)
  }

  /** Merge the authoritative durable baseline with attributed process-local metadata. */
  snapshot(ctx: Context, session: Session): MayflyWorkflowSnapshot {
    const baseline = this.baseline(ctx, session)
    const runs = new Map<string, MayflyWorkflowRun>()
    for (const run of baseline.runs) runs.set(run.id, run)
    for (const live of this.runs.values()) {
      if (live.parentSessionId !== session.id && !runs.has(live.id)) continue
      runs.set(live.id, mergeRun(runs.get(live.id), live))
    }
    return frozen({ sessionId: session.id, runs: [...runs.values()].toSorted((left, right) => left.startedAt - right.startedAt) })
  }
}

function stale(sessionId: SessionId): RemoteError<'mayflyHost/session-stale'> {
  return new RemoteError('mayflyHost/session-stale', `session "${sessionId}" changed before the Workflow stream ended`, { sessionId })
}

/** Follow one exact parent Agent with a baseline followed only by atomic replacements. */
export async function* followWorkflow(
  ctx: Context,
  catalog: WorkflowLiveCatalog,
  sessionId: SessionId,
  signal: AbortSignal,
): RemoteStream<MayflyWorkflowFrame> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  const session = agent.session
  const queue = new ChangeQueue<MayflyWorkflowFrame>(signal)
  let lastSignature = ''
  const snapshot = (): MayflyWorkflowFrame | undefined => {
    requireExactAgent(ctx, sessionId, agent)
    const value = catalog.snapshot(ctx, session)
    const signature = JSON.stringify(value)
    if (signature === lastSignature) return undefined
    lastSignature = signature
    return frozen({ type: 'replacement', value })
  }
  const publish = (): void => {
    try {
      const frame = snapshot()
      if (frame !== undefined) queue.push(frame)
    } catch (error) {
      queue.fail(error)
    }
  }
  const offCatalog = catalog.subscribe((runId) => {
    if (runId === undefined || catalog.affects(ctx, session, runId)) publish()
  })
  const offProjection = ctx.sessionProjections.onChanged((changed, key) => {
    if (changed === session && key === 'mayflyWorkflow') publish()
  })
  const offAgent = ctx.on('agent/disposed', ({ agent: disposed }) => {
    if (disposed === agent) queue.fail(stale(sessionId))
  })
  try {
    signal.throwIfAborted()
    const baseline = catalog.snapshot(ctx, session)
    lastSignature = JSON.stringify(baseline)
    yield frozen({ type: 'baseline', value: baseline })
    for await (const next of queue) yield next
  } finally {
    offCatalog()
    offProjection()
    offAgent()
    queue.finish()
  }
}
