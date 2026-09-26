/**
 * `mayfly-pane-agents` — the S33 subagent pane (the acceptance-ruling form,
 * the kimi `AgentSwarmProgressComponent` semantics): the running subagent
 * group renders as a dock pane pinned directly above the input editor —
 * always visible while agents run, never scrolling into history — and the
 * spawn-class tool calls (`subagent` / `subagent_fork`) render nothing in
 * the stream (the conversation projection routes them to `agents`): this
 * pane is their only presentation surface.
 *
 * The pane is self-hosted like the todo pane: current-session and official
 * facts subscriptions rebuild it from spawn-class calls, and it owns its
 * projection-backed child-session tracker for the live overlay. The group
 * card is projected to canonical nodes with the same group summary, tree,
 * live metrics, and activity detail as the transcript-era component. A group that has fully
 * settled stays visible until the next `turn/start` (kimi deletes the
 * swarm pane at the next turn begin, so the settled summary is readable
 * between turns and vanishes without a trace); a group still running
 * (continuable background agents) persists across the boundary. A resumed
 * session rebuilds the settled card from the snapshot with no live overlay
 * — the A+ form — and the pane renders zero rows with no agents.
 *
 * Publishing is signature-gated: every notification recomputes cheap
 * per-member keys, and `pane.set` only runs when the rendered content
 * actually changed. Structural fields (phases, labels, tool/token counts,
 * activity lines) publish immediately; volatile fields (streamed char
 * counts, elapsed seconds) ride a short tick so a swarm of streaming
 * children cannot publish faster than the cadence.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { ConversationAgentCall, ConversationFacts } from '../conversation/index.ts'
import type { SessionFactsService } from './session-facts.ts'
import { agentCallLabel, agentPhasePresentation, agentTreeBranch, compactElapsedSeconds } from './agent-presentation.ts'
import type { AgentLiveLookup, AgentMemberLive } from './agent-group.ts'
import { trackChildAgentModels } from './child-agent-model.ts'
import { parseToolArguments } from './present.ts'
import { formatTokens } from './status-context.ts'
import type { TranscriptToolItem } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-agents'

/** Services required before the pane can mount. */
export const inject = ['mayflyPanes', 'mayflySessionFacts']

/** A fresh child must remain waiting for this long before the badge changes. */
const WAITING_HOLD_MS = 1000

/** Volatile labels (streamed chars, elapsed seconds) republish on this cadence. */
export const PANE_TICK_MS = 250

let paneAgentsNow: () => number = Date.now

/** Replace the pane clock for deterministic tests. */
export function setPaneAgentsClock(now: (() => number) | undefined): void {
  paneAgentsNow = now ?? Date.now
}

/** One pane-local member shaped for the existing group-card renderer. */
interface PaneMember {
  readonly item: TranscriptToolItem
}

/** The computed render inputs for one member row, split into dedupe keys. */
interface MemberRowView {
  readonly item: TranscriptToolItem
  readonly live: AgentMemberLive | undefined
  readonly phaseLabel: string
  readonly phaseTone: MayflyTone
  readonly label: string
  readonly detail: string | undefined
  readonly detailLine: string | undefined
  readonly elapsed: number
  readonly charsText: string | undefined
  readonly last: boolean
  /** Fields that must publish immediately when they change. */
  readonly structure: string
  /** Fields that may republish on the cadence tick. */
  readonly volatile: string
}

/** The computed pane content plus its dedupe signatures. */
interface PaneView {
  readonly rows: readonly MemberRowView[]
  readonly structure: string
  readonly volatile: string
}

/** Memoized stack rows for one member, keyed by its full render signature. */
interface CachedRow {
  readonly key: string
  readonly nodes: readonly MayflyUiNode[]
}

function agentPhase(member: PaneMember, live: AgentLiveLookup | undefined): {
  readonly label: string
  readonly tone: MayflyTone
} {
  return phaseOf(member.item, live?.(member.item))
}

/**
 * Phase for an already-resolved live overlay. A call still unanswered after
 * its turn ended (a cut turn) reads as cancelled rather than running forever.
 */
function phaseOf(item: TranscriptToolItem, live: AgentMemberLive | undefined, turnEnded = false): {
  readonly label: string
  readonly tone: MayflyTone
} {
  const phase = live?.phase
  const unanswered = item.result === undefined && phase !== 'running' && phase !== 'waiting'
  const presentation = agentPhasePresentation(unanswered && turnEnded ? 'cancelled'
    : phase === 'completed' ? 'done'
      : phase ?? (item.result === undefined ? 'pending' : item.result.isError ? 'failed' : 'done'))
  return { label: presentation.label, tone: presentation.tone }
}

function formatElapsed(seconds: number): string {
  return compactElapsedSeconds(seconds)
}

function elapsedSeconds(item: TranscriptToolItem, live: AgentMemberLive | undefined, terminal: boolean, now: number): number {
  const end = terminal ? live?.endedAt ?? item.result?.endedAt : undefined
  return Math.max(0, Math.floor(((end ?? now) - item.startedAt) / 1000))
}

function hasRunningMember(members: readonly PaneMember[], live: AgentLiveLookup | undefined): boolean {
  return members.some(member => {
    const phase = agentPhase(member, live).label
    return phase === 'running' || phase === 'waiting'
  })
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split('\n').find(line => line.trim() !== '')?.trim()
}

function agentLabel(item: TranscriptToolItem): { readonly label: string, readonly detail?: string } {
  return agentCallLabel(item.name, item.parsedArguments, item.arguments)
}

const EMPTY_STRUCTURE = ''

/** The stack items for one member; memoized by callId + full render key. */
function memberNodes(view: MemberRowView): MayflyUiNode[] {
  const metrics = [
    view.live?.model,
    view.live?.effort,
    view.charsText,
    view.live?.toolCount === undefined ? undefined : `${String(view.live.toolCount)} ${view.live.toolCount === 1 ? 'tool' : 'tools'}`,
    formatElapsed(view.elapsed),
    view.live?.tokens === undefined ? undefined : `${String(view.live.tokens)} tokens`,
  ].filter((value): value is string => value !== undefined)
  const failed = view.phaseLabel === 'failed'
  const row = ui.richText([
    { text: `  ${agentTreeBranch(view.last)} `, tone: 'muted' },
    { text: `${view.phaseLabel} `, tone: view.phaseTone, styles: ['strong'] },
    { text: view.label, tone: 'accent' },
    { text: ` · ${[...(view.detail === undefined ? [] : [view.detail]), ...metrics].join(' · ')}`, tone: 'muted' },
  ])
  if (view.detailLine === undefined) return [row]
  return [row, ui.text(`  ${view.last ? '   ' : '│  '}    ${failed ? `Error: ${view.detailLine}` : view.detailLine}`, { tone: failed ? 'danger' : 'muted' })]
}

/** The whole pane node for one computed view; null renders zero rows. */
function paneNode(view: PaneView, cachedRows: Map<string, CachedRow>): MayflyUiNode | null {
  if (view.rows.length === 0) return null
  const counts = new Map<string, number>()
  for (const row of view.rows) counts.set(row.phaseLabel, (counts.get(row.phaseLabel) ?? 0) + 1)
  const maxElapsed = Math.max(...view.rows.map(row => row.elapsed))
  const settled = view.rows.every(row => row.phaseLabel === 'done' || row.phaseLabel === 'failed' || row.phaseLabel === 'cancelled')
  const noun = view.rows.length === 1 ? 'agent' : 'agents'
  const summary: MayflyInlineSpan[] = settled
    ? [
        { text: '✓ ', tone: 'success' },
        { text: `${String(view.rows.length)} ${noun} finished`, tone: 'accent', styles: ['strong'] },
        { text: ` · ${formatElapsed(maxElapsed)}`, tone: 'muted' },
      ]
    : [
        { text: '● ', tone: 'accent' },
        { text: `Running ${String(view.rows.length)} ${noun}`, tone: 'accent', styles: ['strong'] },
        { text: ` (${['done', 'failed', 'cancelled', 'running', 'waiting'].flatMap(label => {
          const count = counts.get(label) ?? 0
          return count === 0 ? [] : [`${String(count)} ${label}`]
        }).join(', ')}) · ${formatElapsed(maxElapsed)}`, tone: 'muted' },
      ]
  return ui.stack.column([
    ui.divider(),
    ui.richText(summary),
    ...view.rows.flatMap((row): readonly MayflyUiNode[] => {
      const key = `${row.structure}${row.volatile}`
      const cached = cachedRows.get(row.item.callId)
      if (cached?.key === key) return cached.nodes
      const nodes = memberNodes(row)
      cachedRows.set(row.item.callId, { key, nodes })
      return nodes
    }),
  ], { gap: 0 })
}

/**
 * Mount the agents pane bottom-pinned; unloading the fiber unmounts it and
 * releases the current session's subscription and tracker.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let members: PaneMember[] = []
  let tracker: ReturnType<typeof trackChildAgentModels> | undefined
  let liveLookup: AgentLiveLookup | undefined
  let refresh = (): void => undefined
  /** The latest facts turn and activity, to recognize calls whose turn ended. */
  let factsTurn = -1
  let factsActive = false
  const turnEnded = (item: TranscriptToolItem): boolean => item.turn < factsTurn || (item.turn === factsTurn && !factsActive)
  const waitingSince = new Map<string, number>()
  const waitingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const itemCache = new Map<string, { readonly call: ConversationAgentCall, readonly item: TranscriptToolItem }>()
  const labelCache = new Map<string, { readonly item: TranscriptToolItem, readonly value: { readonly label: string, readonly detail?: string } }>()
  const errorLineCache = new Map<string, { readonly item: TranscriptToolItem, readonly line: string | undefined }>()
  const rowCache = new Map<string, CachedRow>()
  let lastStructure = EMPTY_STRUCTURE
  let lastVolatile = ''
  let volatilePending = false
  let tickTimer: ReturnType<typeof setInterval> | undefined
  const stopTick = (): void => {
    if (tickTimer === undefined) return
    clearInterval(tickTimer)
    tickTimer = undefined
  }
  const clearWaiting = (id: string): void => {
    waitingSince.delete(id)
    const timer = waitingTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    waitingTimers.delete(id)
  }
  const labelOf = (item: TranscriptToolItem): { readonly label: string, readonly detail?: string } => {
    const cached = labelCache.get(item.callId)
    if (cached?.item === item) return cached.value
    const value = agentLabel(item)
    labelCache.set(item.callId, { item, value })
    return value
  }
  const errorLineOf = (item: TranscriptToolItem): string | undefined => {
    const cached = errorLineCache.get(item.callId)
    if (cached?.item === item) return cached.line
    const line = firstNonEmptyLine(item.result!.text)
    errorLineCache.set(item.callId, { item, line })
    return line
  }
  const displayLookup: AgentLiveLookup = (member) => {
    const live = liveLookup?.(member)
    if (live?.phase !== 'waiting') {
      clearWaiting(member.callId)
      return live
    }
    const since = waitingSince.get(member.callId)
    if (since === undefined) {
      waitingSince.set(member.callId, paneAgentsNow())
      const timer = setTimeout(() => {
        waitingTimers.delete(member.callId)
        refresh()
      }, WAITING_HOLD_MS)
      timer.unref()
      waitingTimers.set(member.callId, timer)
      return { ...live, phase: 'running' }
    }
    return paneAgentsNow() - since >= WAITING_HOLD_MS ? live : { ...live, phase: 'running' }
  }
  const currentView = (): PaneView => {
    if (members.length === 0) return { rows: [], structure: EMPTY_STRUCTURE, volatile: '' }
    const now = paneAgentsNow()
    const rows = members.map((member, index): MemberRowView => {
      const item = member.item
      const live = displayLookup(item)
      const phase = phaseOf(item, live, turnEnded(item))
      const elapsed = elapsedSeconds(item, live, phase.label === 'done' || phase.label === 'failed' || phase.label === 'cancelled', now)
      const { label, detail } = labelOf(item)
      const detailLine = phase.label === 'failed'
        ? item.result?.isError === true
          ? errorLineOf(item)
          : 'Failed'
        : live?.activity
      const last = index === members.length - 1
      const charsText = live?.liveChars === undefined ? undefined : `↓${formatTokens(live.liveChars)}`
      const structure = JSON.stringify([
        item.callId,
        phase.label,
        label,
        detail ?? null,
        live?.model ?? null,
        live?.effort ?? null,
        live?.toolCount ?? null,
        live?.tokens ?? null,
        charsText !== undefined,
        detailLine ?? null,
        last,
      ])
      const volatile = JSON.stringify([charsText ?? null, elapsed])
      return {
        item, live, phaseLabel: phase.label, phaseTone: phase.tone, label, detail, detailLine,
        elapsed, charsText, last, structure, volatile,
      }
    })
    const maxElapsed = Math.max(...rows.map(row => row.elapsed))
    return {
      rows,
      structure: JSON.stringify(rows.map(row => row.structure)),
      volatile: JSON.stringify([formatElapsed(maxElapsed), rows.map(row => row.volatile)]),
    }
  }

  /**
   * Whether every current member truly finished: the parent projection alone
   * settles a foreground call, but a background ack lands within
   * milliseconds while the child still runs — the live overlay is the
   * authority there (a running member keeps the pane across turns).
   */
  let lastTurn = -1
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  const sync = (next: ConversationFacts): void => {
    factsTurn = next.turn
    factsActive = next.active
    const settled = members.length > 0 && members.every(member => {
      const phase = liveLookup?.(member.item)?.phase
      if (phase === 'running' || phase === 'waiting') return false
      return member.item.result !== undefined || turnEnded(member.item)
    })
    if (next.turn > lastTurn && settled) members = []
    lastTurn = Math.max(lastTurn, next.turn)
    members = next.agentCalls.filter(call => {
      // The current turn's calls stay; an older turn's call stays only while its agent still runs.
      if (call.turn === next.turn) return true
      const existing = members.find(member => member.item.callId === call.callId)
      const phase = existing === undefined ? undefined : liveLookup?.(existing.item)?.phase
      return phase === 'running' || phase === 'waiting'
    }).map((call): PaneMember => {
      const cached = itemCache.get(call.callId)
      if (cached?.call === call) return { item: cached.item }
      const item: TranscriptToolItem = {
        kind: 'tool', seq: call.seq, turn: call.turn, step: call.step, callId: call.callId,
        name: call.name, arguments: call.arguments, startedAt: call.startedAt,
        ...(call.result === undefined ? {} : { result: { ...call.result, fullText: call.result.text } }),
      }
      const parsed = parseToolArguments(item.arguments)
      if (parsed !== undefined) item.parsedArguments = parsed
      itemCache.set(call.callId, { call, item })
      return { item }
    })
    refresh()
  }
  tracker = trackChildAgentModels(facts, () => {
    refresh()
  })
  liveLookup = tracker.snapshot
  const offFacts = facts.subscribe(sync)
  ctx.effect(() => () => offFacts())
  let sessionId = facts.currentAgent?.id
  const offAgent = facts.subscribeAgent((agent) => {
    if (agent?.id === sessionId) return
    sessionId = agent?.id
    lastTurn = -1
    members = []
    itemCache.clear()
    labelCache.clear()
    errorLineCache.clear()
    rowCache.clear()
    for (const id of waitingSince.keys()) clearWaiting(id)
    refresh()
  })
  ctx.effect(() => () => offAgent())

  const pane = ctx.mayflyPanes.register({
    id: 'mayfly.pane.agents',
    placement: 'bottom',
    priority: 50,
    narrow: 'bottom',
  }, null)
  const publish = (view: PaneView): void => {
    lastStructure = view.structure
    lastVolatile = view.volatile
    volatilePending = false
    pane.set(paneNode(view, rowCache))
    if (rowCache.size > view.rows.length) {
      const live = new Set(view.rows.map(row => row.item.callId))
      for (const id of rowCache.keys()) if (!live.has(id)) rowCache.delete(id)
    }
  }
  const syncTick = (): void => {
    if (!hasRunningMember(members, liveLookup) && !volatilePending) {
      stopTick()
      return
    }
    if (tickTimer !== undefined) return
    tickTimer = setInterval(() => {
      const view = currentView()
      volatilePending = false
      if (view.structure !== lastStructure || view.volatile !== lastVolatile) publish(view)
      if (!hasRunningMember(members, liveLookup)) stopTick()
    }, PANE_TICK_MS)
    tickTimer.unref()
  }
  refresh = () => {
    const view = currentView()
    if (view.structure !== lastStructure) publish(view)
    else if (view.volatile !== lastVolatile) volatilePending = true
    syncTick()
  }
  refresh()
  ctx.effect(() => {
    return () => {
      tracker?.dispose()
      stopTick()
      for (const id of waitingSince.keys()) clearWaiting(id)
      pane.dispose()
    }
  })
}
