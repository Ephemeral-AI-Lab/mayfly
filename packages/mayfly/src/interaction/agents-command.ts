/**
 * `/agents` browser over the native subagent descendant catalog.
 *
 * @module @ephemeral-ai/mayfly/interaction/agents-command
 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import { panel, ui, type MayflyListItem, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { formatTokens } from './usage.ts'
import { compactElapsedMs } from '../transcript/agent-presentation.ts'
import { outputCounter } from '../transcript/output-rate.ts'
import { stopBlockedReason, stopSubagent, describe, type AgentStopResult } from './agents-stop.ts'
import { conversationId } from '../app/conversation-views.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-agents-command'

/** How often an open `/agents` browser repaints its live rows while a child runs. */
export const AGENTS_TICK_MS = 1_000

/** How many workflow labels to keep: a conversation's useful labels, bounded so a long process cannot grow the map. */
export const WORKFLOW_LABEL_LIMIT = 256

/**
 * A bounded, least-recently-used map of workflow child labels. A label is read by the browser and rewritten when the
 * workflow reports the child again; the oldest unused label is dropped past {@link WORKFLOW_LABEL_LIMIT}.
 */
export class WorkflowLabelCache {
  private readonly labels = new Map<string, string>()

  constructor(private readonly limit = WORKFLOW_LABEL_LIMIT) {}

  get size(): number { return this.labels.size }

  get(key: string): string | undefined {
    const label = this.labels.get(key)
    if (label === undefined) return undefined
    this.labels.delete(key)
    this.labels.set(key, label)
    return label
  }

  remember(key: string, label: string): void {
    const trimmed = label.trim()
    if (trimmed === '') return
    this.labels.delete(key)
    this.labels.set(key, trimmed)
    while (this.labels.size > this.limit) this.labels.delete(this.labels.keys().next().value!)
  }

  clear(): void { this.labels.clear() }
}

/** Native and Mayfly services required by the browser and attach view. */
export const inject = [
  'commands',
  'subagents',
  'agents',
  'sessions',
  'sessionProjections',
  'mayflyConversations',
  'mayflyCurrentAgent',
  'mayflyOverlays',
  'mayflyLiveAssistantStream',
  'tools',
]

/** Native row plus optional metrics and stream phase from a currently resident child. */
export type MayflySubagentTreeEntry = SubagentDescendantListEntry & {
  readonly tokens?: number | undefined
  readonly toolCount?: number | undefined
  readonly liveChars?: number | undefined
  readonly settledMs?: number | undefined
  readonly activeSince?: number | undefined
  readonly streamPhase?: 'thinking' | 'composing' | undefined
}

/** The reserved label of the `/btw` side conversation's native fork child. */
const BTW_LABEL = 'btw'

/** Keep the side question out of the delegation browser: it is its own conversation. */
function listedDescendants(entries: readonly SubagentDescendantListEntry[]): readonly SubagentDescendantListEntry[] {
  return entries.filter(entry => entry.kind !== 'child' || entry.label !== BTW_LABEL)
}

/** Elapsed format used by agent browser rows. */
export function formatAgentElapsed(ms: number): string {
  return compactElapsedMs(ms)
}

/** Optional live-output, tool, token, and elapsed summary. */
export function agentMetricsText(
  entry: { readonly tokens?: number | undefined, readonly toolCount?: number | undefined, readonly liveChars?: number | undefined, readonly settledMs?: number | undefined, readonly activeSince?: number | undefined },
  now: number,
): string {
  const parts: string[] = []
  const down = outputCounter(entry.liveChars ?? 0)
  if (down !== '') parts.push(down)
  if (entry.toolCount !== undefined) parts.push(`${String(entry.toolCount)} ${entry.toolCount === 1 ? 'tool' : 'tools'}`)
  if (entry.tokens !== undefined) parts.push(`${formatTokens(entry.tokens)} tok`)
  const elapsed = entry.activeSince !== undefined ? now - entry.activeSince : entry.settledMs
  if (elapsed !== undefined) parts.push(formatAgentElapsed(elapsed))
  return parts.join(' · ')
}

/**
 * Full native tree declaration consumed by the shared Tree/Choice state.
 * `stopBlocked` names why Stop cannot run for a row, so the action shows the
 * reason instead of confirming a stop that the native check would refuse.
 */
export function agentTreeItems(entries: readonly MayflySubagentTreeEntry[], now = Date.now(), stopBlocked?: (entry: Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>) => string | undefined): readonly MayflyListItem[] {
  const ids = new Set(entries.map(entry => String(entry.id)))
  return entries.map(entry => {
    const id = String(entry.id)
    const parentId = String(entry.parentId)
    if (entry.kind === 'diagnostic') return {
      id, label: `⚠ ${id}`, detail: `diagnostic: ${entry.reason}`, disabled: true,
      ...(ids.has(parentId) ? { parentId } : {}),
    }
    const label = entry.label ?? id
    const metrics = agentMetricsText(entry, now)
    const stream = entry.streamPhase === 'thinking' ? 'Thinking…' : entry.streamPhase === 'composing' ? 'Writing…' : undefined
    const blocked = stopBlocked?.(entry)
    return {
      id,
      label: `${entry.activity === 'running' ? '●' : '○'} ${label}`,
      detail: [entry.mode, ...(stream === undefined ? [] : [stream]), ...(metrics === '' ? [] : [metrics])].join(' · '),
      searchText: `${label} ${id} ${entry.mode}`,
      ...(ids.has(parentId) ? { parentId } : {}),
      ...(entry.activity === 'running' ? { badge: 'running' } : {}),
      ...(blocked === undefined ? {} : { unavailableActions: { stop: blocked } }),
    }
  })
}

function withLiveMetrics(
  ctx: Context,
  entries: readonly SubagentDescendantListEntry[],
  workflowLabels: { get(key: string): string | undefined },
): readonly MayflySubagentTreeEntry[] {
  const sessions = new Map([...ctx.sessions.list()].map(session => [String(session.id), session]))
  const liveStream = ctx.get('mayflyLiveAssistantStream')
  return entries.map(entry => {
    if (entry.kind !== 'child') return entry
    const workflowLabel = workflowLabels.get(String(entry.id))
    const labeled = entry.label === undefined && workflowLabel !== undefined
      ? { ...entry, label: workflowLabel }
      : entry
    const agent = ctx.agents.get(entry.id)
    const draft = agent === undefined ? undefined : liveStream?.get(agent)
    /* The durable catalog marks activity from the resident registry; refresh it
       per publish so a finishing child drops its running badge without relist.
       The transient stream draft reports thinking/composing while durable
       facts still read waiting. */
    const resident = {
      ...labeled,
      activity: agent?.status === 'running' ? 'running' as const : 'inactive' as const,
      ...(draft !== undefined && (draft.phase === 'thinking' || draft.phase === 'composing') ? { streamPhase: draft.phase } : {}),
      ...(draft !== undefined && draft.chars > 0 ? { liveChars: draft.chars } : {}),
    }
    const session = sessions.get(String(entry.id))
    if (session === undefined) return resident
    const values = ctx.sessionProjections.snapshot(session, ['mayflyConversationFacts', 'subagentTiming']).values
    const facts = values.mayflyConversationFacts as { readonly epochTokens?: unknown, readonly epochToolCount?: unknown } | undefined
    const timing = values.subagentTiming as { readonly settledMs?: unknown, readonly active?: { readonly since?: unknown } } | undefined
    return {
      ...resident,
      ...(typeof facts?.epochTokens === 'number' ? { tokens: facts.epochTokens } : {}),
      ...(typeof facts?.epochToolCount === 'number' ? { toolCount: facts.epochToolCount } : {}),
      ...(typeof timing?.settledMs === 'number' ? { settledMs: timing.settledMs } : {}),
      ...(typeof timing?.active?.since === 'number' ? { activeSince: timing.active.since } : {}),
    }
  })
}

/** Register `/agents`; every open browser and attach is fiber-owned. */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const workflowLabels = new WorkflowLabelCache()
  let closeOpenBrowser: (() => void) | undefined
  let unloaded = false
  const rememberWorkflowLabel = (agent: WorkflowAgentInfo): void => {
    workflowLabels.remember(String(agent.childId), agent.label)
  }
  ctx.on('workflow/agent-start', (_info, agent) => { rememberWorkflowLabel(agent) })
  ctx.on('workflow/agent-end', (_info, agent) => { rememberWorkflowLabel(agent) })

  const stopEntry = (entryId: string, signal: AbortSignal): Promise<AgentStopResult> => stopSubagent(ctx, entryId, signal, t, () => unloaded)

  async function showAgents(signal: AbortSignal): Promise<CommandResult> {
    if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('agents panel is unavailable: the Mayfly screen is not mounted') }
    const parent = ctx.mayflyCurrentAgent.primary()
    if (parent === null) return { kind: 'error', text: t('no session is live yet') }
    // The tree browses the primary's descendants: show the primary beneath it.
    ctx.mayflyConversations.display(conversationId(String(parent.id)))
    let listed: readonly SubagentDescendantListEntry[]
    try {
      listed = listedDescendants(await ctx.subagents.listDescendants(parent.id, signal))
    } catch (error) {
      return { kind: 'error', text: describe(error) }
    }
    if (unloaded || ctx.mayflyCurrentAgent.current() !== parent) return { kind: 'success' }
    if (listed.length === 0) return { kind: 'success', text: t('no subagents in this session') }
    closeOpenBrowser?.()
    let entries = withLiveMetrics(ctx, listed, workflowLabels)
    let byId = new Map(entries.map(entry => [String(entry.id), entry]))
    let handle: MayflyOverlayHandle | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    const lifetime = new AbortController()
    const disposers: (() => void)[] = []
    const teardown = (): void => {
      if (closed) return
      closed = true
      closeOpenBrowser = undefined
      lifetime.abort()
      for (const dispose of disposers.splice(0)) dispose()
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
    }
    const close = (): void => { teardown(); handle?.close() }
    disposers.push(ctx.mayflyCurrentAgent.subscribe(next => {
      if (next !== parent) close()
    }))
    const stopBlocked = (entry: Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>): string | undefined => stopBlockedReason(ctx, t, entries, entry)
    const view = () => panel({ title: t('Subagents'), escapeLabel: 'close', body: ui.stack.column([
      ui.list({ id: 'subagents', role: 'browse', tree: true, selectedIds: [], filterable: true, filterMode: 'slash', items: agentTreeItems(entries, Date.now(), stopBlocked) }),
      ui.actions({ id: 'subagent-actions', items: [
        { id: 'stop', label: t('Stop selected'), hintLabel: t('stop'), key: 'x', hidden: true, intent: 'danger', confirm: { title: t('Stop selected subagent?'), detail: t('Its live Agent shuts down; the stored conversation stays browsable.'), confirmLabel: t('Stop'), tone: 'danger' }, selections: [{ pagePath: [], controlId: 'subagents' }] },
      ] }),
    ]) })
    const publish = (force: boolean): void => {
      /* every publish caller is closed-fenced already; these checks only narrow the handle for the view write and fence a host-driven close race */
      if (closed || handle === undefined || handle.closed) return
      const next = withLiveMetrics(ctx, listed, workflowLabels)
      if (force || !isDeepStrictEqual(next, entries)) {
        entries = next
        byId = new Map(next.map(entry => [String(entry.id), entry]))
        handle.set(view())
      }
      const live = next.some(entry => entry.kind === 'child' && entry.activity === 'running')
      if (live && timer === undefined) { timer = setInterval(() => publish(true), AGENTS_TICK_MS); timer.unref() }
      else if (!live && timer !== undefined) { clearInterval(timer); timer = undefined }
    }
    const relist = async (): Promise<void> => {
      let next: readonly SubagentDescendantListEntry[]
      try { next = listedDescendants(await ctx.subagents.listDescendants(parent.id, lifetime.signal)) } catch { return }
      if (closed || unloaded || ctx.mayflyCurrentAgent.primary() !== parent) return
      listed = next
      publish(false)
    }
    handle = openUiOverlay(ctx, { id: 'mayfly.agents', presentation: 'editor', capturing: true, dismissal: 'discard', scope: { kind: 'session', sessionId: parent.id }, onEvent: { action: async (event, context) => {
      if (event.kind === 'selection-accept') {
        const selectedId = event.selectedIds[0]
        const entry = selectedId === undefined ? undefined : byId.get(selectedId)
        if (entry?.kind !== 'child') return { kind: 'completed' }
        if (entry.mode === 'external') return { kind: 'failed', message: t('External subagents have no local conversation') }
        close()
        ctx.mayflyConversations.open({ kind: 'subagent', sessionId: String(entry.id), parentSessionId: String(entry.parentId), label: entry.label ?? String(entry.id), mode: entry.mode })
        return { kind: 'completed' }
      }
      if (event.kind !== 'activate' || event.actionId !== 'stop') return { kind: 'completed' }
      const selectedId = event.inputs?.selections?.find(selection => selection.controlId === 'subagents')?.selectedIds[0]
      if (selectedId === undefined) return { kind: 'failed', message: t('Select a subagent first') }
      const result = await stopEntry(selectedId, context.signal)
      if (result.kind === 'error') return { kind: 'failed', message: result.text }
      try {
        listed = await ctx.subagents.listDescendants(parent.id, context.signal)
        publish(false)
      } catch { /* the native stop already completed; retain the last readable tree */ }
      return { kind: 'completed', feedback: { severity: 'success', message: result.text } }
    } } }, view(), { reopen: 'replace', onClosed: teardown })
    disposers.push(ctx.sessionProjections.onChanged(session => {
      if (!closed && byId.has(String(session.id))) publish(false)
    }))
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      if (!closed && agent.session.header.origin === 'subagent') void relist()
    }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      if (!closed && byId.has(String(agent.id))) publish(false)
    }))
    publish(false)
    closeOpenBrowser = close
    return { kind: 'success' }
  }

  const command = ctx.commands.register({
    name: 'agents',
    description: t('Browse this session\'s subagents, view one, or stop a continuable child'),
    input: { hint: '[stop <id>]' },
    handler: async (invocation) => {
      const input = invocation.rawInput.trim()
      if (input === '') return showAgents(invocation.signal)
      const match = /^stop\s+(\S+)$/u.exec(input)
      if (match === null) return { kind: 'error', text: 'usage: /agents [stop <id>]' }
      return stopEntry(match[1]!, invocation.signal)
    },
  })
  ctx.effect(() => () => {
    unloaded = true
    closeOpenBrowser?.()
    command()
  })
}
