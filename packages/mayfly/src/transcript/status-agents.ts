/**
 * The Agents item of the status row: a views pane over the managed subagent
 * activations the attached Agent started. Membership is the parent's own
 * durable spawn calls plus its native `subagentCatalog`; each row's mode,
 * label, active turn, and duration come from the child's `subagent`,
 * `subagentTiming`, and presentation facts. There is no foreground or
 * background form: every delegation is one managed activation, so a row is
 * live while that activation is, and settles through the native
 * `subagent/start` / `subagent/end` pair or the child's own settled facts.
 * The row carries `● agents 1/3` (settled over all) and stays, `✓ agents 3/3`,
 * until a new conversation. The panel, shown under the row while the view is
 * entered (`Alt+↓`), is a list of every subagent of the conversation, live
 * first, one line each: the mark, the name (external executions are marked
 * `(ext)`), and what it is doing, then at the right edge its tokens in and
 * out, its rate, and its time. `↑/↓` choose a row, `Enter` opens a local
 * child's conversation (the same view `/agents` opens; `F7` returns), and `x`
 * stops a continuable child through `drainChildren` behind the shared Yes/No.
 * An external child has no local conversation and no local Agent to stop. The
 * registration is the Fiber's.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentCatalogEntry, SubagentIdentityProjection, SubagentRunEndInfo, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { ConversationAgentCall, OutputProgress } from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { interactionTranslator } from '../interaction/locale.ts'
import { stopSubagent } from '../interaction/agents-stop.ts'
import { agentCallLabel, compactElapsedMs } from './agent-presentation.ts'
import { parseActivationResult } from './child-agent-model.ts'
import { observeTranscriptLocale, transcriptTranslator } from './locale.ts'
import { outputRate } from './output-rate.ts'
import { formatTokens } from './status-context.ts'
import { parseToolArguments } from './present.ts'
import type { ChildSessionFacts, SessionFactsService } from './session-facts.ts'
import type { TickSource } from './tick.ts'
import { itemSummary, viewList } from './view-items.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-agents'

/** Native and Mayfly services required by the view. */
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflyScreen', 'mayflySessionFacts', 'mayflyTick', 'mayflyConversations', 'subagents', 'agents', 'sessionProjections']

/** The Agents view's place in the status row: after git (10), before jobs (12), goal (13), and todo (14). */
const VIEW_PRIORITY = 11

/** The list's id; the keys read the chosen row from it. */
const LIST_ID = 'agents-list'
const STOP_ID = 'agents-stop'

/** Characters of a row's task kept before the row's own truncation. */
const TASK_MAX_CHARS = 80

/** The native mode of one subscription: a local continuation or an external execution. */
export type AgentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'

/** The native activation state of one child, as the lifecycle events report it. */
export interface AgentRunState {
  readonly live: boolean
  /** The native terminal stop reason, once the activation ended. */
  readonly stopReason?: string | undefined
  /** Envelope time the end event reached this view. */
  readonly endedAt?: number | undefined
}

/** One subagent as the item shows it. */
export interface AgentRow {
  /** The spawn call's id. */
  readonly id: string
  /** The child's durable session id, once the activation named it. */
  readonly childId?: string
  readonly label: string
  readonly task?: string
  /** The child's native mode; `external` children have no local conversation. */
  readonly mode: AgentMode
  /** True for an external execution: no local conversation, no local Agent. */
  readonly external: boolean
  readonly live: boolean
  /** The subagent failed on its own (a non-aborted stop reason, or a failed call). */
  readonly failed: boolean
  /** The subagent was stopped by the user (aborted, or stopped from the panel), which is no failure. */
  readonly stopped: boolean
  /** What the child is doing now (`Thinking…`, `Using bash`), while its facts say so. */
  readonly activity?: string
  /** Tokens of the settled steps: input (cache included) and output. */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Streamed characters of the live attempt, which count toward the output until the step settles. */
  readonly liveChars: number
  /** The live attempt's output progress, for the token rate. */
  readonly outputProgress?: OutputProgress
  readonly startedAt: number
  readonly endedAt?: number
}

/** What the item renders from. */
export interface AgentsState {
  /** Every subagent of the conversation, in spawn order. */
  readonly rows: readonly AgentRow[]
  /** The time the elapsed figures are measured against. */
  readonly now: number
}

/** Native per-child facts the view reads beside the parent's spawn calls. */
export interface AgentNativeFacts {
  /** The parent's durable direct-child catalog. */
  readonly catalog: readonly SubagentCatalogEntry[]
  /** The live children's presentation facts. */
  readonly children: readonly ChildSessionFacts[]
  /** Each reachable child's native timing projection, by session id. */
  readonly timing: ReadonlyMap<string, SubagentTimingProjection>
  /** Each reachable child's native identity projection, by session id. */
  readonly identity: ReadonlyMap<string, SubagentIdentityProjection | null>
  /** The native activation state of each child observed this session. */
  readonly runs: ReadonlyMap<string, AgentRunState>
}

/** What the rows are derived from. */
export interface AgentRowsInput extends AgentNativeFacts {
  /** The parent's own spawn calls, in order. */
  readonly calls: readonly ConversationAgentCall[]
  /** The parent's current turn and whether it is active. */
  readonly turn: Readonly<{ readonly turn: number, readonly active: boolean }>
  /** Whether a local child's resident Agent is gone, which ends its work. */
  readonly gone?: ((childId: string) => boolean) | undefined
  /** The children the user stopped from the panel. */
  readonly stoppedByUser?: ReadonlySet<string> | undefined
}

/**
 * The summary in the row: the mark, `agents`, and how many have settled over
 * how many there are: `● agents 1/3`, then `✓ agents 3/3` (`✕` when one failed
 * on its own; one the user stopped is no failure). It stays for the
 * conversation.
 * @param state - the rows.
 * @param t - translator for the label.
 * @returns the summary, or `null` when the conversation has no subagent.
 */
export function agentsSummary(state: AgentsState, t: MayflyTranslate): MayflyPaneSummary | null {
  const { rows } = state
  if (rows.length === 0) return null
  const live = rows.filter(row => row.live)
  const mark: MayflyInlineSpan = live.length > 0 ? { text: '●', tone: 'accent' } : rows.some(row => row.failed) ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
  return { node: itemSummary(mark, t('agents'), rows.length - live.length, rows.length) }
}

function markOf(row: AgentRow): MayflyInlineSpan {
  if (row.live) return { text: '●', tone: 'accent' }
  if (row.stopped) return { text: '⊘', tone: 'muted' }
  return row.failed ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
}

/** One row: `● review  Using bash                       ↑5.2k  ↓6.4k  38 tok/s · 41s`. */
function agentItem(row: AgentRow, now: number, unavailable: Readonly<Record<string, string>>): MayflyListItem {
  const elapsed = compactElapsedMs(Math.max(0, (row.live ? now : row.endedAt ?? now) - row.startedAt))
  const up = row.inputTokens
  const down = row.outputTokens + Math.floor(row.liveChars / 4)
  const count = (mark: string, tokens: number): string => tokens === 0 ? '' : `${mark}${formatTokens(tokens)}`
  const measured = row.live ? outputRate(row.outputProgress, now) : ''
  const rate = measured.startsWith('0 ') ? '' : measured
  // The figures (tokens in and out, the rate) two spaces apart, then the time behind a small dot, as the Activity row has it.
  const figures = [count('↑', up), count('↓', down), rate].filter(text => text !== '')
  const right: MayflyInlineSpan[] = [
    ...figures.length === 0 ? [] : [{ text: `${figures.join('  ')} · `, tone: 'muted' as const }],
    { text: elapsed, tone: 'muted' },
  ]
  // The mark says how it ended; the brief is what it does now (its streamed activity) and its task once it settled.
  const doing = row.live && row.activity !== undefined
  const brief = doing ? row.activity : row.task
  return {
    id: row.id,
    label: `${row.label}${row.external ? ' (ext)' : ''}${row.task === undefined ? '' : `  ${row.task}`}`,
    labelSpans: [markOf(row), { text: ' ' }],
    cells: [
      { spans: [{ text: row.label, tone: 'accent' }, ...row.external ? [{ text: ' (ext)', tone: 'muted' as const }] : []], max: 28 },
      { spans: brief === undefined ? [] : [{ text: brief, tone: doing ? 'default' : 'muted' }], max: 52, shed: 1 },
    ],
    right,
    unavailableActions: unavailable,
  }
}

/**
 * The panel: every subagent of the conversation in the list every item with
 * chosen rows shares, live first, with `x` beside it (it names why it cannot
 * act on a row that cannot take it).
 * @param state - the rows.
 * @param t - translator for the words.
 * @param unavailable - why a key cannot act on a row, by row id.
 * @returns the panel node, or `null` when the conversation has no subagent.
 */
export function agentsPanel(state: AgentsState, t: MayflyTranslate, unavailable: (row: AgentRow) => Readonly<Record<string, string>>): MayflyUiNode | null {
  if (state.rows.length === 0) return null
  const rows = state.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(b.row.live) - Number(a.row.live) || a.index - b.index)
    .map(({ row }) => row)
  const selections = [{ pagePath: [], controlId: LIST_ID }]
  const actions = ui.actions({
    id: 'agents-actions',
    items: [
      {
        id: STOP_ID, label: t('stop'), hidden: true, semantic: 'delete', hintLabel: t('stop'), selections,
        confirm: { title: t('Stop this subagent?'), detail: t('Its live Agent shuts down; the stored conversation stays browsable.'), confirmLabel: t('Stop'), tone: 'danger' },
      },
    ],
  })
  return viewList(LIST_ID, rows.map(row => agentItem(row, state.now, unavailable(row))), actions)
}

/** The activation label a spawn call passed to the native service, when it reads. */
function spawnLabel(call: ConversationAgentCall): string | undefined {
  const parsed = parseToolArguments(call.arguments)
  const args = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  const description = args['description']
  return typeof description === 'string' && description.trim() !== '' ? description : undefined
}

/**
 * Correlate the parent's spawn calls with its catalog. The activation result
 * names the child exactly; a result that is not the canonical
 * `{ kind: 'activation', subagentId }` JSON is not interpreted, so the same
 * call's native activation label (the `description` the tool passed) finds
 * the catalog row instead. Prompt text is never matched.
 */
function childIdsOf(calls: readonly ConversationAgentCall[], catalog: readonly SubagentCatalogEntry[]): readonly (string | undefined)[] {
  const claimed = new Set<string>()
  return calls.map((call) => {
    const exact = parseActivationResult(call.result?.text)?.subagentId
    if (exact !== undefined) {
      claimed.add(exact)
      return exact
    }
    const label = spawnLabel(call)
    if (label === undefined) return undefined
    const found = catalog.find(entry => entry.label === label && !claimed.has(String(entry.id)))
    if (found === undefined) return undefined
    claimed.add(String(found.id))
    return String(found.id)
  })
}

/**
 * The rows of a conversation: one per parent spawn call, enriched with the
 * native catalog, the child's native identity/timing, its presentation facts,
 * and the activation lifecycle this view observed. A call with no result is
 * still starting and counts as working until its turn is cut; an activation
 * that ended reports its native stop reason, so an aborted child is stopped
 * and a failed one failed.
 * @param input - the calls, native facts, turn, and user-stop memory.
 * @returns the rows, in spawn order.
 */
export function agentRows(input: AgentRowsInput): readonly AgentRow[] {
  const children = new Map(input.children.map(child => [child.id, child]))
  const catalog = new Map(input.catalog.map(entry => [String(entry.id), entry]))
  const childIds = childIdsOf(input.calls, input.catalog)
  return input.calls.map((call, index): AgentRow => {
    const childId = childIds[index]
    const child = childId === undefined ? undefined : children.get(childId)
    const entry = childId === undefined ? undefined : catalog.get(childId)
    const identity = childId === undefined ? undefined : input.identity.get(childId)
    const timing = childId === undefined ? undefined : input.timing.get(childId)
    const run = childId === undefined ? undefined : input.runs.get(childId)
    const mode: AgentMode = entry?.mode === 'external' ? 'external' : identity?.mode ?? entry?.mode ?? 'unknown'
    const external = mode === 'external'
    const cut = call.turn < input.turn.turn || (call.turn === input.turn.turn && !input.turn.active)
    const gone = childId !== undefined && (input.gone?.(childId) ?? false)
    // The resident Agent is the activation's own publication: after mount it
    // is the direct native liveness signal when no start event was seen.
    const resident = childId !== undefined && !external && input.gone !== undefined && !gone
    const working = (child?.phase === 'running' || child?.phase === 'waiting')
      || timing?.active !== undefined
      || (resident && child === undefined)
      || (childId !== undefined && input.gone === undefined && !external && !cut && call.result === undefined)
    // A native end event is authoritative; without one the native child facts
    // and the activation's own start state decide.
    const live = run === undefined
      ? external ? false : (call.result === undefined ? !cut && !gone : working && !gone)
      : run.live
    const stopReason = run?.stopReason
    const stopped = !live && (stopReason === 'aborted'
      || child?.stopped === true
      || (childId !== undefined && (input.stoppedByUser?.has(childId) ?? false))
      || (gone && (child?.phase === 'running' || child?.phase === 'waiting')))
    const failed = !live && !stopped && (stopReason !== undefined
      ? stopReason !== 'completed'
      : child?.phase === 'failed'
        || call.result?.isError === true
        || call.result === undefined)
    const { label: callLabel, detail } = agentCallLabel(call.name, parseToolArguments(call.arguments), call.arguments)
    const label = identity?.label ?? entry?.label ?? callLabel
    const endedAt = run?.endedAt ?? child?.endedAt ?? call.result?.endedAt
    return {
      id: call.callId,
      ...childId === undefined ? {} : { childId },
      label,
      ...detail === undefined ? {} : { task: detail.length > TASK_MAX_CHARS ? `${detail.slice(0, TASK_MAX_CHARS - 1)}…` : detail },
      mode,
      external,
      live,
      failed,
      stopped,
      ...child?.activity === undefined ? {} : { activity: child.activity },
      inputTokens: child?.inputTokens ?? 0,
      outputTokens: child?.outputTokens ?? 0,
      liveChars: live ? child?.liveChars ?? 0 : 0,
      ...live && child?.outputProgress !== undefined ? { outputProgress: child.outputProgress } : {},
      startedAt: call.startedAt,
      ...endedAt === undefined ? {} : { endedAt },
    }
  })
}

/** Read one child's native projections from its exact resident Agent. */
function childNative(ctx: Context, childId: string): { readonly timing?: SubagentTimingProjection, readonly identity: SubagentIdentityProjection | null } | undefined {
  const child = ctx.agents.get(SessionId(childId))
  if (child === undefined) return undefined
  const values = ctx.sessionProjections.snapshot(child.session, ['subagentTiming', 'subagent']).values
  return {
    ...values.subagentTiming === undefined ? {} : { timing: values.subagentTiming },
    identity: values.subagent ?? null,
  }
}

/** Register the Agents item under the calling Fiber. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const ti = interactionTranslator(ctx)
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  const lifetime = new AbortController()
  let unloaded = false
  /** The children the user stopped from the panel: their last facts may still read working. */
  const stoppedByUser = new Set<string>()
  /** The native activation state of every child this view observed. */
  const runs = new Map<string, AgentRunState>()

  /** The conversation this view opened, until it closes: closing it (`F8`) returns to this view instead of the prompt. */
  let opened: string | undefined
  let displayed: string | null = null

  const act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || agent !== owner) return { kind: 'failed', message: t('The agent changed; open it again') }
    const stopping = event.kind === 'activate' && event.actionId === STOP_ID
    if (event.kind !== 'selection-accept' && !stopping) return { kind: 'completed' }
    const chosen = event.kind === 'selection-accept' ? event.selectedIds[0]
      : event.kind === 'activate' ? event.inputs?.selections?.find(selection => selection.controlId === LIST_ID)?.selectedIds[0]
        : undefined
    const row = rows.find(candidate => candidate.id === chosen)
    if (row === undefined) return { kind: 'failed', message: t('Select a subagent first') }
    if (row.external) return { kind: 'failed', message: stopping ? ti('Only continuable subagents can be stopped') : t('This subagent cannot be opened') }
    if (row.childId === undefined) return { kind: 'failed', message: t('This subagent has not started yet') }
    try {
      if (event.kind === 'selection-accept') {
        const entry = (await ctx.subagents.listChildren(agent.id, context.signal)).find(candidate => String(candidate.id) === row.childId)
        if (entry === undefined || entry.mode === 'external') return { kind: 'failed', message: t('This subagent cannot be opened') }
        ctx.mayflyScreen.leaveViews()
        opened = ctx.mayflyConversations.open({ kind: 'subagent', sessionId: row.childId, parentSessionId: String(agent.id), label: entry.label ?? row.label, mode: entry.mode })
        return { kind: 'completed' }
      }
      const result = await stopSubagent(ctx, row.childId, context.signal, ti, () => unloaded)
      if (result.kind === 'error') return { kind: 'failed', message: result.text }
      stoppedByUser.add(row.childId)
      refresh()
      return { kind: 'completed', feedback: { severity: 'success', message: result.text } }
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
  const pane = ctx.mayflyPanes.register({ id: 'mayfly.view.agents', placement: 'views', priority: VIEW_PRIORITY, onEvent: { action: act } }, null)

  /** The Agent the rows belong to: an action built for another is refused. */
  let owner = ctx.mayflyCurrentAgent.current()
  let children: readonly ChildSessionFacts[] = []
  let calls: readonly ConversationAgentCall[] = []
  /** The projection's calls before the own ones are picked out of them. */
  let inherited: readonly ConversationAgentCall[] = []
  let turn = { turn: 0, active: false }
  let catalog: readonly SubagentCatalogEntry[] = []
  let timing: ReadonlyMap<string, SubagentTimingProjection> = new Map()
  let identity: ReadonlyMap<string, SubagentIdentityProjection | null> = new Map()
  let rows: readonly AgentRow[] = []
  let now = Date.now()
  let published = ''
  let offTick: (() => void) | undefined

  const syncTick = (): void => {
    if (!rows.some(row => row.live)) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => { now = at; publish() })
  }
  /** Why `x` cannot act on a row, from the native mode and liveness the rows already hold. */
  const unavailable = (row: AgentRow): Readonly<Record<string, string>> => {
    const stop = row.external ? ti('Only continuable subagents can be stopped')
      : !row.live || row.childId === undefined ? ti('Not live; there is nothing to stop')
        : row.mode !== 'continuable' ? ti('Only continuable subagents can be stopped')
          : undefined
    return stop === undefined ? {} : { [STOP_ID]: stop }
  }
  /** The parent catalog and each reachable child's native identity/timing at this cut. */
  const readNative = (agent: Agent | null): Pick<AgentNativeFacts, 'catalog' | 'timing' | 'identity'> => {
    if (agent === null) return { catalog: [], timing: new Map(), identity: new Map() }
    const parent = ctx.sessionProjections.snapshot(agent.session, ['subagentCatalog']).values.subagentCatalog
    const current = Array.isArray(parent) ? parent : []
    const nextTiming = new Map<string, SubagentTimingProjection>()
    const nextIdentity = new Map<string, SubagentIdentityProjection | null>()
    for (const child of current) {
      const native = childNative(ctx, String(child.id))
      if (native?.timing !== undefined) nextTiming.set(String(child.id), native.timing)
      if (native !== undefined) nextIdentity.set(String(child.id), native.identity)
    }
    return { catalog: current, timing: nextTiming, identity: nextIdentity }
  }

  const publish = (): void => {
    rows = agentRows({
      calls, children, catalog, timing, identity, runs, turn,
      gone: id => ctx.agents.get(SessionId(id)) === undefined,
      stoppedByUser,
    })
    syncTick()
    const state: AgentsState = { rows, now }
    const summary = agentsSummary(state, t)
    const panel = agentsPanel(state, t, unavailable)
    const key = JSON.stringify([summary, panel])
    if (key === published) return
    published = key
    pane.set(panel)
    pane.setSummary(summary)
  }
  const refresh = (): void => {
    if (unloaded) return
    now = Date.now()
    const agent = ctx.mayflyCurrentAgent.current()
    const native = readNative(agent)
    catalog = native.catalog
    timing = native.timing
    identity = native.identity
    publish()
  }

  const offAgent = facts.subscribeAgent((agent) => {
    if (agent === owner) return
    owner = agent
    children = []
    calls = []
    inherited = []
    turn = { turn: 0, active: false }
    stoppedByUser.clear()
    runs.clear()
    refresh()
  })
  const offFacts = facts.subscribe((next) => {
    if (next.agentCalls === inherited && next.turn === turn.turn && next.active === turn.active) return
    inherited = next.agentCalls
    // A side conversation or a subagent inherits its parent's log: only the calls it made itself are its own subagents.
    const session = ctx.mayflyCurrentAgent.current()?.session
    calls = session === undefined ? next.agentCalls : next.agentCalls.filter(call => session.isOwnSeq(call.seq as never))
    turn = { turn: next.turn, active: next.active }
    refresh()
  })
  const offChildren = facts.subscribeChildren((next) => {
    children = next
    refresh()
  })
  const offProjections = ctx.sessionProjections.onChanged((session, key) => {
    if (unloaded) return
    if (key === 'subagentCatalog') refresh()
    else if ((key === 'subagentTiming' || key === 'subagent') && rows.some(row => row.childId === String(session.id))) refresh()
  })
  const offStart = ctx.on('subagent/start', (info) => {
    runs.set(String(info.id), { live: true })
    refresh()
  })
  const offEnd = ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    runs.set(String(info.id), { live: false, stopReason: info.stopReason, endedAt: Date.now() })
    refresh()
  })
  const offConversations = ctx.mayflyConversations.subscribe((snapshot) => {
    const wasDisplayed = displayed
    displayed = snapshot.displayedId
    if (opened === undefined) return
    if (snapshot.views.some(view => view.id === opened)) {
      // Left for another conversation (`F7`): a later display of it is no longer this view's doing (`/agents` may reopen it).
      if (wasDisplayed === opened && snapshot.displayedId !== opened) opened = undefined
      return
    }
    const closed = opened
    opened = undefined
    // The displayed child was closed and the parent shows again: back into the view that opened it.
    // Focus goes back to the prompt as the conversation changes, so the view is entered after that.
    if (wasDisplayed !== closed || snapshot.displayedId !== snapshot.primaryId) return
    const agent = owner
    setImmediate(() => { if (!unloaded && ctx.mayflyCurrentAgent.current() === agent) ctx.mayflyScreen.enterViews() })
  })
  const offLocale = observeTranscriptLocale(ctx, () => { published = ''; publish() })
  // A child's Agent coming or going changes whether its activation is resident.
  ctx.effect(() => ctx.on('agent/created', () => { refresh() }))
  ctx.effect(() => ctx.on('agent/disposed', () => { refresh() }))
  ctx.effect(() => () => {
    unloaded = true
    lifetime.abort()
    offAgent()
    offFacts()
    offChildren()
    offProjections()
    offStart()
    offEnd()
    offConversations()
    offLocale()
    offTick?.()
    pane.dispose()
  })
}
