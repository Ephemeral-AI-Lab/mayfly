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
import { ui, type MayflyListItem, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { formatTokens } from './usage.ts'
import { compactElapsedMs } from '../transcript/agent-presentation.ts'
import { outputCounter } from '../transcript/output-rate.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-agents-command'

/** Native and Mayfly services required by the browser and attach view. */
export const inject = [
  'commands',
  'subagents',
  'agents',
  'sessions',
  'sessionProjections',
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

/** Count live Agent descendants whose teardown would follow the selected root. */
export function liveAgentDescendantCount(
  entries: readonly SubagentDescendantListEntry[],
  rootId: string,
  isLive: (entry: Extract<SubagentDescendantListEntry, { readonly kind: 'child' }>) => boolean,
): number {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  let count = 0
  for (const entry of entries) {
    if (entry.kind !== 'child' || !isLive(entry) || String(entry.id) === rootId) continue
    let parentId = String(entry.parentId)
    const seen = new Set<string>()
    while (!seen.has(parentId)) {
      if (parentId === rootId) {
        count += 1
        break
      }
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (parent === undefined) break
      parentId = String(parent.parentId)
    }
  }
  return count
}

function descendantStopError(entry: SubagentDescendantListEntry, count: number): AgentCommandResult | undefined {
  if (count === 0) return undefined
  return {
    kind: 'error',
    text: `subagent ${String(entry.id)} owns ${String(count)} live descendant${count === 1 ? '' : 's'}; stop its live descendants first`,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type AgentCommandResult = Readonly<{ kind: 'success' | 'error', text: string }>

function withLiveMetrics(
  ctx: Context,
  entries: readonly SubagentDescendantListEntry[],
  workflowLabels: ReadonlyMap<string, string>,
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
  const workflowLabels = new Map<string, string>()
  let closeOpenBrowser: (() => void) | undefined
  let unloaded = false
  const rememberWorkflowLabel = (agent: WorkflowAgentInfo): void => {
    const label = agent.label.trim()
    if (label !== '') workflowLabels.set(String(agent.childId), label)
  }
  ctx.on('workflow/agent-start', (_info, agent) => { rememberWorkflowLabel(agent) })
  ctx.on('workflow/agent-end', (_info, agent) => { rememberWorkflowLabel(agent) })

  const stopEntry = async (entryId: string, signal: AbortSignal): Promise<AgentCommandResult> => {
    const primary = ctx.mayflyCurrentAgent.primary()
    if (primary === null) return { kind: 'error', text: t('no session is live yet') }
    let latest: readonly SubagentDescendantListEntry[]
    try {
      latest = await ctx.subagents.listDescendants(primary.id, signal)
    } catch (error) {
      return { kind: 'error', text: describe(error) }
    }
    if (unloaded || ctx.mayflyCurrentAgent.primary() !== primary) {
      return { kind: 'error', text: `subagent ${entryId} stop request is stale` }
    }
    const current = latest.find(candidate => candidate.kind === 'child' && String(candidate.id) === entryId)
    if (current?.kind !== 'child') return { kind: 'error', text: `unknown subagent: ${entryId}` }
    if (current.mode !== 'continuable') {
      return { kind: 'error', text: `subagent ${String(current.id)} is not continuable` }
    }
    const descendantError = descendantStopError(current, liveAgentDescendantCount(
      latest,
      String(current.id),
      candidate => ctx.agents.get(candidate.id) !== undefined,
    ))
    if (descendantError !== undefined) return descendantError
    if (ctx.agents.get(current.id) === undefined) {
      return { kind: 'error', text: `subagent ${String(current.id)} is not live; there is no running Agent to stop` }
    }
    const directParent = ctx.agents.get(current.parentId)
    if (directParent === undefined) {
      return { kind: 'error', text: `cannot stop subagent ${String(current.id)}: its direct parent is not live` }
    }
    if (ctx.mayflyCurrentAgent.view().auxiliary?.sessionId === String(current.id)) {
      ctx.mayflyCurrentAgent.closeAuxiliary()
    }
    try {
      await ctx.subagents.drainContinuableChildren(directParent, [current.id])
      return { kind: 'success', text: `stopped subagent ${String(current.id)}` }
    } catch (error) {
      return { kind: 'error', text: `could not stop subagent ${String(current.id)}: ${describe(error)}` }
    }
  }

  async function showAgents(signal: AbortSignal): Promise<CommandResult> {
    if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('agents panel is unavailable: the Mayfly screen is not mounted') }
    const parent = ctx.mayflyCurrentAgent.primary()
    if (parent === null) return { kind: 'error', text: t('no session is live yet') }
    ctx.mayflyCurrentAgent.closeAuxiliary()
    let listed: readonly SubagentDescendantListEntry[]
    try {
      listed = await ctx.subagents.listDescendants(parent.id, signal)
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
    /* Mirrors stopEntry's native checks so Stop explains itself per row. */
    const stopBlocked = (entry: Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>): string | undefined => {
      if (entry.mode !== 'continuable') return t('Only continuable subagents can be stopped')
      if (ctx.agents.get(entry.id) === undefined) return t('Not live; there is nothing to stop')
      return liveAgentDescendantCount(entries, String(entry.id), candidate => ctx.agents.get(candidate.id) !== undefined) > 0
        ? t('Stop its live descendants first')
        : undefined
    }
    const view = () => ui.surface({ title: t('Subagents'), chrome: 'overlay', child: ui.stack.column([
      ui.list({ id: 'subagents', role: 'browse', tree: true, selectedIds: [], filterable: true, items: agentTreeItems(entries, Date.now(), stopBlocked) }),
      ui.actions({ id: 'subagent-actions', items: [
        { id: 'stop', label: t('Stop selected'), intent: 'danger', confirm: { title: t('Stop selected subagent?'), detail: t('Its live Agent shuts down; the stored conversation stays browsable.'), confirmLabel: t('Stop'), tone: 'danger' }, selections: [{ pagePath: [], controlId: 'subagents' }] },
        { id: 'close', label: t('Close'), dismiss: true },
      ] }),
    ]) })
    const publish = (force: boolean): void => {
      /* v8 ignore next -- every publish caller is closed-fenced already; these checks only narrow the handle for the view write and fence a host-driven close race */
      if (closed || handle === undefined || handle.closed) return
      const next = withLiveMetrics(ctx, listed, workflowLabels)
      if (force || !isDeepStrictEqual(next, entries)) {
        entries = next
        byId = new Map(next.map(entry => [String(entry.id), entry]))
        handle.set(view())
      }
      const live = next.some(entry => entry.kind === 'child' && entry.activity === 'running')
      if (live && timer === undefined) { timer = setInterval(() => publish(true), 1000); timer.unref() }
      else if (!live && timer !== undefined) { clearInterval(timer); timer = undefined }
    }
    const relist = async (): Promise<void> => {
      let next: readonly SubagentDescendantListEntry[]
      try { next = await ctx.subagents.listDescendants(parent.id, lifetime.signal) } catch { return }
      if (closed || unloaded || ctx.mayflyCurrentAgent.primary() !== parent) return
      listed = next
      publish(false)
    }
    handle = openUiOverlay(ctx, { id: 'mayfly.agents', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Subagents'), scope: { kind: 'session', sessionId: parent.id }, onEvent: { action: async (event, context) => {
      if (event.kind === 'selection-accept') {
        const selectedId = event.selectedIds[0]
        const entry = selectedId === undefined ? undefined : byId.get(selectedId)
        if (entry?.kind !== 'child') return { kind: 'completed' }
        close()
        ctx.mayflyCurrentAgent.openAuxiliary({ kind: 'subagent', sessionId: String(entry.id), parentSessionId: String(entry.parentId), label: entry.label ?? String(entry.id), mode: entry.mode })
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
