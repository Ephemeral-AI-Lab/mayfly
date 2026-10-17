/**
 * The Agents item of the status row: a views pane over the subagents the attached Agent has spawned in this
 * conversation. Its members are the parent's spawn calls, so a subagent shows from the moment its call starts, however
 * short it lives: a call without its result is a foreground subagent (it blocks the turn), a call whose acknowledgement
 * (`started subagent <id>`) landed is a background one; the child's own facts add its tools, time, and output. The row
 * carries `● agents 1/3` (settled over all) and stays, `✓ agents 3/3`, until a new conversation. The panel, shown under
 * the row while the view is entered (`Alt+↓`), is a list of every subagent of the conversation, live first, one line
 * each: the mark, the name with `(fg)` or `(bg)`, and what it is doing (its streamed activity while it works, its task
 * once it settled), then at the right edge its tokens in and out, its rate, and its time. `↑/↓` choose a row, `Enter` opens its conversation (the
 * same view `/agents` opens; `F7` returns), `x` stops a continuable child behind the shared Yes/No, and `b` would move a
 * foreground one to the background (dsh offers no such call yet, so it is listed as unavailable). The registration is
 * the Fiber's.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { ConversationAgentCall, OutputProgress } from '../conversation/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { interactionTranslator } from '../interaction/locale.ts'
import { stopSubagent } from '../interaction/agents-stop.ts'
import { agentCallLabel, compactElapsedMs } from './agent-presentation.ts'
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
export const inject = ['mayflyPanes', 'mayflyCurrentAgent', 'mayflyScreen', 'mayflySessionFacts', 'mayflyTick', 'mayflyConversations', 'subagents', 'agents']

/** The Agents view's place in the status row: after git (10), before jobs (12), goal (13), and todo (14). */
const VIEW_PRIORITY = 11

/** The list's id; the keys read the chosen row from it. */
const LIST_ID = 'agents-list'
const STOP_ID = 'agents-stop'
const BACKGROUND_ID = 'agents-background'

/** Why `b` is not offered yet: moving a running foreground subagent to the background needs a call dsh does not have. */
const BACKGROUND_UNAVAILABLE = 'dsh cannot move a running subagent to the background yet'

/** Characters of a row's task kept before the row's own truncation. */
const TASK_MAX_CHARS = 80

/** One subagent as the item shows it. */
export interface AgentRow {
  /** The spawn call's id. */
  readonly id: string
  /** The child's session id, once it is known. */
  readonly childId?: string
  readonly label: string
  readonly task?: string
  /** A foreground subagent blocks the turn that spawned it; a background one does not. */
  readonly foreground: boolean
  readonly live: boolean
  /** The subagent failed on its own (an error, or its call failed). */
  readonly failed: boolean
  /** The subagent was stopped by the user (interrupted, aborted, or stopped from the panel), which is no failure. */
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

/**
 * The summary in the row: the mark, `agents`, and how many have settled over how many there are: `● agents 1/3`, then
 * `✓ agents 3/3` (`✕` when one failed on its own; one the user stopped is no failure). It stays for the conversation.
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

/** One row: `● review(bg)  Using bash                       ↑5.2k  ↓6.4k  38 tok/s · 41s`. */
function agentItem(row: AgentRow, now: number, t: MayflyTranslate, unavailable: Readonly<Record<string, string>>): MayflyListItem {
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
    label: `${row.label}${row.task === undefined ? '' : `  ${row.task}`}`,
    labelSpans: [markOf(row), { text: ' ' }],
    cells: [
      { spans: [{ text: row.label, tone: 'accent' }, { text: `(${t(row.foreground ? 'fg' : 'bg')})`, tone: 'muted' }], max: 28 },
      { spans: brief === undefined ? [] : [{ text: brief, tone: doing ? 'default' : 'muted' }], max: 52, shed: 1 },
    ],
    right,
    unavailableActions: unavailable,
  }
}

/**
 * The panel: every subagent of the conversation in the list every item with chosen rows shares, live first, with the
 * keys beside it: `x` stops and `b` backgrounds (both name why they are unavailable on a row that cannot take them).
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
      { id: BACKGROUND_ID, label: t('background'), hidden: true, key: 'b', hintLabel: t('background'), selections },
    ],
  })
  return viewList(LIST_ID, rows.map(row => agentItem(row, state.now, t, unavailable(row))), actions)
}

/** What a spawn call says of its child: where it is found, whether it runs in the background, and its parsed arguments. */
interface SpawnFacts {
  readonly ackId?: string
  readonly prompt?: string
  readonly background: boolean
  readonly args: unknown
}

/**
 * Parsed spawn arguments by call object, so one publish parses a call once for its row and its label. A republished
 * conversation may hand a fresh call object with equal identity and arguments; that falls back to a bounded map keyed
 * by the call's identity, never by the parsed text.
 */
const spawnByCall = new WeakMap<ConversationAgentCall, SpawnFacts>()
const spawnByKey = new Map<string, SpawnFacts>()
const SPAWN_CACHE_LIMIT = 512

function spawnOf(call: ConversationAgentCall): SpawnFacts {
  const known = spawnByCall.get(call)
  if (known !== undefined) return known
  const key = `${call.callId}\u0000${String(call.seq)}\u0000${String(call.turn)}\u0000${String(call.step)}\u0000${call.result?.text ?? ''}\u0000${call.arguments}`
  const cached = spawnByKey.get(key)
  if (cached !== undefined) {
    spawnByCall.set(call, cached)
    return cached
  }
  const parsed = parseToolArguments(call.arguments)
  const args = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  const ackId = /started subagent ([\w-]+)/u.exec(call.result?.text ?? '')?.[1]
  const spawn: SpawnFacts = {
    ...ackId === undefined ? {} : { ackId },
    ...typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {},
    background: ackId !== undefined || args['run_in_background'] === true,
    args: parsed,
  }
  spawnByCall.set(call, spawn)
  if (spawnByKey.size >= SPAWN_CACHE_LIMIT) spawnByKey.delete(spawnByKey.keys().next().value!)
  spawnByKey.set(key, spawn)
  return spawn
}

/**
 * The rows of a conversation: one per spawn call. A call without its result is a subagent that blocks the turn (and
 * works, unless its turn was cut); one with an acknowledgement works while its child's facts say so, and a child whose facts
 * never came is taken to work only while the turn that spawned it does. The child's facts add its tools, time, and output.
 * @param calls - the parent's spawn calls.
 * @param children - the facts of the parent's direct children.
 * @param turn - the parent's current turn and whether it is active.
 * @param gone - whether a child's resident Agent is gone, which ends its work.
 * @param stoppedByUser - the children the user stopped from the panel.
 * @returns the rows, in spawn order.
 */
export function agentRows(calls: readonly ConversationAgentCall[], children: readonly ChildSessionFacts[], turn: { readonly turn: number, readonly active: boolean }, gone: (childId: string) => boolean = () => false, stoppedByUser: ReadonlySet<string> = new Set()): readonly AgentRow[] {
  const byId = new Map(children.map(child => [child.id, child]))
  const byPrompt = new Map<string, ChildSessionFacts>()
  for (const child of children) if (child.promptText !== undefined && !byPrompt.has(child.promptText)) byPrompt.set(child.promptText, child)
  return calls.map((call): AgentRow => {
    const spawn = spawnOf(call)
    const child = (spawn.ackId === undefined ? undefined : byId.get(spawn.ackId)) ?? (spawn.prompt === undefined ? undefined : byPrompt.get(spawn.prompt))
    const cut = call.turn < turn.turn || (call.turn === turn.turn && !turn.active)
    // A continuable child whose Agent is gone (stopped) is not working, whatever its last facts say.
    const working = (child?.phase === 'running' || child?.phase === 'waiting') && !gone(child.id)
    const live = call.result === undefined ? working || !cut : spawn.background ? (child === undefined ? !cut : working) : false
    const childId = child?.id ?? spawn.ackId
    // Stopped by the user: its run was interrupted or aborted, or its Agent was shut down while its facts still said it worked.
    const stopped = !live && (child?.stopped === true || (childId !== undefined && stoppedByUser.has(childId)) || (child !== undefined && (child.phase === 'running' || child.phase === 'waiting') && gone(child.id)))
    const failed = !live && !stopped && (child?.phase === 'failed' || (call.result?.isError === true && !spawn.background) || call.result === undefined)
    const { label, detail } = agentCallLabel(call.name, spawn.args, call.arguments)
    const endedAt = live ? undefined : child?.endedAt ?? call.result?.endedAt
    return {
      id: call.callId,
      ...childId === undefined ? {} : { childId },
      label,
      ...detail === undefined ? {} : { task: detail.length > TASK_MAX_CHARS ? `${detail.slice(0, TASK_MAX_CHARS - 1)}…` : detail },
      foreground: !spawn.background,
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

/** Register the Agents item under the calling Fiber. */
export function apply(ctx: Context): void {
  const t = transcriptTranslator(ctx, 'transcript')
  const ti = interactionTranslator(ctx)
  const tick = ctx.get('mayflyTick') as TickSource | undefined
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  let unloaded = false
  /** The children the user stopped from the panel: their last facts may still read working. */
  const stoppedByUser = new Set<string>()

  /** The conversation this view opened, until it closes: closing it (`F8`) returns to this view instead of the prompt. */
  let opened: string | undefined
  let displayed: string | null = null

  const act = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null || agent !== owner) return { kind: 'failed', message: t('The agent changed; open it again') }
    const activated = event.kind === 'activate' && (event.actionId === STOP_ID || event.actionId === BACKGROUND_ID)
    if (event.kind !== 'selection-accept' && !activated) return { kind: 'completed' }
    const chosen = event.kind === 'selection-accept' ? event.selectedIds[0]
      : event.kind === 'activate' ? event.inputs?.selections?.find(selection => selection.controlId === LIST_ID)?.selectedIds[0]
        : undefined
    const row = rows.find(candidate => candidate.id === chosen)
    if (row === undefined) return { kind: 'failed', message: t('Select a subagent first') }
    if (event.kind === 'activate' && event.actionId === BACKGROUND_ID) return { kind: 'failed', message: t(BACKGROUND_UNAVAILABLE) }
    if (row.childId === undefined) return { kind: 'failed', message: t('This subagent has not started yet') }
    try {
      if (event.kind === 'selection-accept') {
        const entry = (await ctx.subagents.listChildren(agent.id, context.signal)).find(candidate => String(candidate.id) === row.childId)
        if (entry === undefined || entry.mode === 'unknown') return { kind: 'failed', message: t('This subagent cannot be opened') }
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
  /** The catalog's mode of each child, read when the set of children changes (the hint on a one-shot row). */
  const modes = new Map<string, string>()
  let catalogFor = ''
  let rows: readonly AgentRow[] = []
  let now = Date.now()
  let published = ''
  let offTick: (() => void) | undefined

  const syncTick = (): void => {
    if (!rows.some(row => row.live)) { offTick?.(); offTick = undefined; return }
    offTick ??= tick?.subscribe((at) => { now = at; publish() })
  }
  /** Why `x` and `b` cannot act on a row, from what is known without descending the catalog; the native check answers the rest. */
  const unavailable = (row: AgentRow): Readonly<Record<string, string>> => {
    const mode = row.childId === undefined ? undefined : modes.get(row.childId)
    const stop = !row.live || row.childId === undefined || ctx.agents.get(row.childId as Agent['id']) === undefined ? ti('Not live; there is nothing to stop')
      : mode !== undefined && mode !== 'continuable' ? ti('Only continuable subagents can be stopped')
        : undefined
    // `b` is offered on a working foreground row (and answers why it cannot act); every other row names why it has no `b`.
    const background = row.live && row.foreground ? undefined : row.live ? t('Already in the background') : t('Already finished')
    return { ...stop === undefined ? {} : { [STOP_ID]: stop }, ...background === undefined ? {} : { [BACKGROUND_ID]: background } }
  }
  const readCatalog = (): void => {
    const agent = ctx.mayflyCurrentAgent.current()
    const key = `${agent === null ? '' : String(agent.id)}:${rows.map(row => row.childId ?? '').join(',')}`
    if (agent === null || key === catalogFor) return
    catalogFor = key
    void ctx.subagents.listChildren(agent.id).then((entries) => {
      if (unloaded || ctx.mayflyCurrentAgent.current() !== agent) return
      modes.clear()
      for (const entry of entries) modes.set(String(entry.id), entry.mode)
      published = ''
      publish()
    }, () => { /* the hint is optional: the native check answers at the key */ })
  }

  const publish = (): void => {
    rows = agentRows(calls, children, turn, id => modes.get(id) === 'continuable' && ctx.agents.get(id as Agent['id']) === undefined, stoppedByUser)
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
    now = Date.now()
    publish()
    readCatalog()
  }

  const offAgent = facts.subscribeAgent((agent) => {
    if (agent === owner) return
    owner = agent
    children = []
    calls = []
    inherited = []
    turn = { turn: 0, active: false }
    modes.clear()
    stoppedByUser.clear()
    catalogFor = ''
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
  // A continuable child's Agent coming or going changes whether it works.
  ctx.effect(() => ctx.on('agent/created', () => { refresh() }))
  ctx.effect(() => ctx.on('agent/disposed', () => { refresh() }))
  ctx.effect(() => () => {
    unloaded = true
    offAgent()
    offFacts()
    offChildren()
    offConversations()
    offLocale()
    offTick?.()
    pane.dispose()
  })
}
