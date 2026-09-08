/**
 * `/agents` browser over the native subagent descendant catalog.
 *
 * @module @ephemeral-ai/mayfly/interaction/agents-command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import { ui, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { formatTokens } from './usage.ts'
import { compactElapsedMs } from '../transcript/agent-presentation.ts'

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
  'tools',
]

/** Native row plus optional metrics from a currently resident child. */
export type MayflySubagentTreeEntry = SubagentDescendantListEntry & {
  readonly tokens?: number | undefined
  readonly settledMs?: number | undefined
  readonly activeSince?: number | undefined
}

/** Elapsed format used by agent browser rows. */
export function formatAgentElapsed(ms: number): string {
  return compactElapsedMs(ms)
}

/** Optional token and elapsed summary. */
export function agentMetricsText(
  entry: { readonly tokens?: number | undefined, readonly settledMs?: number | undefined, readonly activeSince?: number | undefined },
  now: number,
): string {
  const parts: string[] = []
  if (entry.tokens !== undefined) parts.push(`${formatTokens(entry.tokens)} tok`)
  const elapsed = entry.activeSince !== undefined ? now - entry.activeSince : entry.settledMs
  if (elapsed !== undefined) parts.push(formatAgentElapsed(elapsed))
  return parts.join(' · ')
}

/** Full native tree declaration consumed by the shared Tree/Choice state. */
export function agentTreeItems(entries: readonly MayflySubagentTreeEntry[], now = Date.now()): readonly MayflyListItem[] {
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
    return {
      id,
      label: `${entry.activity === 'running' ? '●' : '○'} ${label}`,
      detail: [entry.mode, ...(metrics === '' ? [] : [metrics])].join(' · '),
      searchText: `${label} ${id} ${entry.mode}`,
      ...(ids.has(parentId) ? { parentId } : {}),
      ...(entry.activity === 'running' ? { badge: 'running' } : {}),
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
  return entries.map(entry => {
    if (entry.kind !== 'child') return entry
    const workflowLabel = workflowLabels.get(String(entry.id))
    const labeled = entry.label === undefined && workflowLabel !== undefined
      ? { ...entry, label: workflowLabel }
      : entry
    const session = sessions.get(String(entry.id))
    if (session === undefined) return labeled
    const values = ctx.sessionProjections.snapshot(session, ['mayflyConversationFacts', 'subagentTiming']).values
    const facts = values.mayflyConversationFacts as { readonly epochTokens?: unknown } | undefined
    const timing = values.subagentTiming as { readonly settledMs?: unknown, readonly active?: { readonly since?: unknown } } | undefined
    return {
      ...labeled,
      ...(typeof facts?.epochTokens === 'number' ? { tokens: facts.epochTokens } : {}),
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
    let handle!: ReturnType<typeof openUiOverlay>
    const close = (): void => {
      offAgent()
      closeOpenBrowser = undefined
      handle?.close()
    }
    const offAgent = ctx.mayflyCurrentAgent.subscribe(next => {
      if (next !== parent) close()
    })
    const stopReason = (selectedId: string | undefined): string | undefined => {
      if (selectedId === undefined) return t('Select a subagent first')
      const target = byId.get(selectedId)
      if (target?.kind !== 'child') return t('The selected subagent is no longer available')
      if (target.mode !== 'continuable') return `subagent ${selectedId} is not continuable`
      const descendants = liveAgentDescendantCount(entries, selectedId, candidate => ctx.agents.get(candidate.id) !== undefined)
      const nested = descendantStopError(target, descendants)
      if (nested !== undefined) return nested.text
      if (ctx.agents.get(target.id) === undefined) return `subagent ${selectedId} is not live; there is no running Agent to stop`
      if (ctx.agents.get(target.parentId) === undefined) return `cannot stop subagent ${selectedId}: its direct parent is not live`
      return undefined
    }
    const view = (selectedId?: string) => {
      const reason = stopReason(selectedId)
      const selected = selectedId === undefined ? undefined : byId.get(selectedId)
      const confirm = selected?.kind === 'child' ? t('Stop {agent}?', { agent: selected.label ?? selectedId! }) : t('Stop selected subagent?')
      return ui.surface({ title: t('Subagents'), chrome: 'overlay', child: ui.stack.column([
      ui.list({ id: 'subagents', role: 'choose', tree: true, minSelected: 1, selectedIds: selectedId === undefined ? [] : [selectedId], filterable: true, items: agentTreeItems(entries) }),
      ui.actions({ id: 'subagent-actions', items: [
        { id: 'view', label: t('View selected'), selections: [{ pagePath: [], controlId: 'subagents' }] },
        { id: 'stop', label: t('Stop selected'), intent: 'danger', confirm, selections: [{ pagePath: [], controlId: 'subagents' }], disabled: reason !== undefined, ...(reason === undefined ? {} : { disabledReason: reason }) },
        { id: 'close', label: t('Close'), dismiss: true },
      ] }),
      ]) })
    }
    handle = openUiOverlay(ctx, { id: 'mayfly.agents', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Subagents'), scope: { kind: 'session', sessionId: parent.id }, onEvent: { action: async (event, context) => {
      if (event.kind === 'selection-accept') {
        const selectedId = event.selectedIds[0]
        return selectedId === undefined ? { kind: 'completed' } : { kind: 'accepted', node: view(selectedId), source: [] }
      }
      if (event.kind !== 'activate' || (event.actionId !== 'view' && event.actionId !== 'stop')) return { kind: 'completed' }
      const selectedId = event.inputs?.selections?.find(selection => selection.controlId === 'subagents')?.selectedIds[0]
      const entry = selectedId === undefined ? undefined : byId.get(selectedId)
      if (entry?.kind !== 'child') return { kind: 'failed', message: t('The selected subagent is no longer available') }
      if (event.actionId === 'view') {
        close()
        ctx.mayflyCurrentAgent.openAuxiliary({ kind: 'subagent', sessionId: String(entry.id), parentSessionId: String(entry.parentId), label: entry.label ?? String(entry.id), mode: entry.mode })
        return { kind: 'completed' }
      }
      const result = await stopEntry(selectedId!, context.signal)
      if (result.kind === 'error') return { kind: 'failed', message: result.text }
      try {
        listed = await ctx.subagents.listDescendants(parent.id, context.signal)
        entries = withLiveMetrics(ctx, listed, workflowLabels)
        byId = new Map(entries.map(entry => [String(entry.id), entry]))
        handle.set(view(selectedId))
      } catch { /* the native stop already completed; retain the last readable tree */ }
      return { kind: 'completed', feedback: { severity: 'success', message: result.text } }
    } } }, view())
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
