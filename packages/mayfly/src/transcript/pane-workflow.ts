/**
 * Read-only workflow lifecycle pane attributed to the current Agent through
 * native child Sessions.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workflow'
import type { SessionFactsService } from './session-facts.ts'
import { workflowNode, type WorkflowRunState } from './workflow-model.ts'
export { workflowNode, formatWorkflowElapsed } from './workflow-model.ts'
export type { WorkflowRunState } from './workflow-model.ts'
import { transcriptTranslator } from './locale.ts'
import type { TickSource } from './tick.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-workflow'

/** Native and Mayfly services required by the pane. */
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflySessionFacts', 'sessions', 'mayflyTick']

const WORKFLOW_PRIORITY = 60

/** Injectable clock for deterministic lifecycle tests; the shared one-second tick drives the refresh. */
interface WorkflowPaneClock {
  now: () => number
}

const defaultClock: WorkflowPaneClock = { now: Date.now }
let workflowPaneClock = defaultClock

/** Replace or restore the workflow pane clock. */
export function setWorkflowPaneClock(now: (() => number) | undefined): void {
  workflowPaneClock = now === undefined ? defaultClock : { now }
}

/** Mount the native workflow event fold as a direct bottom-pane contribution. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const runs = new Map<string, WorkflowRunState>()
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  let offTick: (() => void) | undefined
  let now = workflowPaneClock.now()
  let pane: ReturnType<typeof ctx.mayflyPanes.register>

  const currentChildIds = (): Set<string> => {
    const parent = ctx.mayflyCurrentAgent.current()
    if (parent === null) return new Set()
    return new Set([...ctx.sessions.list()].flatMap(session =>
      session.header.origin === 'subagent' && session.header.parentSession === parent.id
        ? [String(session.id)]
        : [],
    ))
  }
  const attribute = (run: WorkflowRunState): boolean => {
    if (run.attributed) return true
    const children = currentChildIds()
    if (run.agents.some(agent => children.has(agent.childId))) run.attributed = true
    return run.attributed
  }
  const attributedRuns = (): readonly WorkflowRunState[] => [...runs.values()].filter(run => run.attributed)
  // The shared one-second tick republishes (and recompiles) only a changed pane.
  let published: string | undefined
  const refresh = (at = workflowPaneClock.now()): void => {
    now = at
    const node = workflowNode(attributedRuns(), now, t)
    const signature = JSON.stringify(node)
    if (signature === published) return
    published = signature
    pane?.set(node)
  }
  const standDownTick = (): void => {
    offTick?.()
    offTick = undefined
  }
  const ensureTick = (): void => {
    const live = attributedRuns().some(run => run.stopReason === undefined)
    if (!live || tick === undefined) {
      standDownTick()
      return
    }
    if (offTick !== undefined) return
    offTick = tick.subscribe((at) => {
      if (!attributedRuns().some(run => run.stopReason === undefined)) standDownTick()
      else refresh(at)
    })
  }

  ctx.on('workflow/start', (info) => {
    runs.set(String(info.id), {
      id: String(info.id),
      name: info.meta.name,
      phases: info.meta.phases,
      phasesSeen: [],
      currentPhase: undefined,
      agents: [],
      startedAt: workflowPaneClock.now(),
      stopReason: undefined,
      endedAt: undefined,
      agentsStarted: undefined,
      attributed: false,
    })
  })
  ctx.on('workflow/phase', (info, title) => {
    const run = runs.get(String(info.id))
    if (run === undefined) return
    run.currentPhase = title
    if (!run.phasesSeen.includes(title)) run.phasesSeen.push(title)
    if (attribute(run)) refresh()
  })
  ctx.on('workflow/log', (info) => {
    const run = runs.get(String(info.id))
    if (run !== undefined) attribute(run)
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    const run = runs.get(String(info.id))
    if (run === undefined) return
    run.agents.push({
      seq: agent.seq,
      label: agent.label,
      phase: agent.phase,
      childId: String(agent.childId),
    })
    if (attribute(run)) refresh()
    ensureTick()
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const run = runs.get(String(info.id))
    if (run === undefined) return
    const member = run.agents.find(candidate => candidate.seq === agent.seq)
    if (member !== undefined) member.outcome = agent.outcome
    if (attribute(run)) refresh()
  })
  ctx.on('workflow/end', (info, result) => {
    const run = runs.get(String(info.id))
    if (run === undefined) return
    if (!attribute(run)) {
      runs.delete(run.id)
      return
    }
    run.stopReason = result.stopReason
    run.endedAt = workflowPaneClock.now()
    run.agentsStarted = result.agentsStarted
    refresh()
    ensureTick()
  })

  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  let lastTurn = -1
  const offFacts = facts.subscribe(next => {
    if (next.turn > lastTurn) {
      let cleared = false
      for (const [id, run] of runs) {
        if (run.stopReason === undefined) continue
        runs.delete(id)
        cleared = true
      }
      if (cleared) {
        refresh()
        ensureTick()
      }
    }
    lastTurn = Math.max(lastTurn, next.turn)
  })
  const offAgent = ctx.mayflyCurrentAgent.subscribe(() => {
    lastTurn = -1
    runs.clear()
    refresh()
    ensureTick()
  })

  const initial = workflowNode(attributedRuns(), workflowPaneClock.now(), t)
  published = JSON.stringify(initial)
  pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.workflow',
    placement: 'bottom',
    priority: WORKFLOW_PRIORITY,
    narrow: 'bottom',
  }, initial)
  ctx.effect(() => () => {
    standDownTick()
    offFacts()
    offAgent()
    pane.dispose()
  })
}
