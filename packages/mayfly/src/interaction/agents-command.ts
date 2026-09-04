/**
 * `/agents` browser over the native subagent descendant catalog.
 *
 * @module @ephemeral-ai/mayfly/interaction/agents-command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import { displayServices } from './display-services.ts'
import { mountEditorReplacement } from './editor-panel-controller.ts'
import { getSharedEditor } from './editor-instance.ts'
import { interactionTranslator } from './locale.ts'
import { CanonicalSelectController, type SelectRow } from './select-list.ts'
import { CanonicalFormController } from './form-panel.ts'
import { formatTokens } from './usage.ts'
import { compactElapsedMs } from '../transcript/agent-presentation.ts'
import { ACTION_CANCEL, ACTION_DELETE, ACTION_MOVE_DOWN, ACTION_MOVE_UP, ACTION_SUBMIT, ACTION_TOGGLE, interactionKeyHint } from './keys.ts'

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
  'mayflyEditorPanels',
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

/** Build visible stable-preorder rows under the local expansion set. */
export function buildAgentRows(
  entries: readonly MayflySubagentTreeEntry[],
  expanded: ReadonlySet<string>,
  now = Date.now(),
): SelectRow[] {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  const hidden = (entry: MayflySubagentTreeEntry): boolean => {
    if (entry.depth <= 1) return false
    let orphan = true
    let cursor = String(entry.parentId)
    while (true) {
      const parent = byId.get(cursor)
      if (parent === undefined) return orphan
      orphan = false
      if (parent.kind === 'child' && parent.hasChildren) {
        if (!expanded.has(String(parent.id))) return true
        cursor = String(parent.parentId)
        continue
      }
      return true
    }
  }
  const rows: SelectRow[] = []
  for (const entry of entries) {
    if (hidden(entry)) continue
    const id = String(entry.id)
    const indent = '  '.repeat(Math.max(0, entry.depth - 1))
    if (entry.kind === 'diagnostic') {
      rows.push({ value: id, label: `${indent}⚠ ${id}`, description: `diagnostic: ${entry.reason}`, disabled: true })
      continue
    }
    const marker = entry.hasChildren ? (expanded.has(id) ? '▾ ' : '▸ ') : ''
    const label = entry.label ?? id
    const metrics = agentMetricsText(entry, now)
    rows.push({
      value: id,
      label: `${indent}${marker}${entry.activity === 'running' ? '●' : '○'} ${label}`,
      description: [entry.mode, ...(metrics === '' ? [] : [metrics])].join(' · '),
      ...(entry.activity === 'running' ? { badge: 'running' } : {}),
      filterText: `${label} ${id} ${entry.mode}`,
    })
  }
  return rows
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

  const stopEntry = async (entry: SubagentDescendantListEntry): Promise<AgentCommandResult> => {
    if (entry.kind !== 'child' || entry.mode !== 'continuable') {
      return { kind: 'error', text: `subagent ${String(entry.id)} is not continuable` }
    }
    const directParent = ctx.agents.get(entry.parentId)
    if (directParent === undefined) {
      return { kind: 'error', text: `cannot stop subagent ${String(entry.id)}: its direct parent is not live` }
    }
    if (ctx.mayflyCurrentAgent.view().auxiliary?.sessionId === String(entry.id)) {
      ctx.mayflyCurrentAgent.closeAuxiliary()
    }
    try {
      await ctx.subagents.drainContinuableChildren(directParent, [entry.id])
      return { kind: 'success', text: `stopped subagent ${String(entry.id)}` }
    } catch (error) {
      return { kind: 'error', text: `could not stop subagent ${String(entry.id)}: ${describe(error)}` }
    }
  }

  const findEntry = async (parentId: Agent['id'], id: string, signal: AbortSignal): Promise<SubagentDescendantListEntry | undefined> => {
    const entries = await ctx.subagents.listDescendants(parentId, signal)
    return entries.find(entry => entry.kind === 'child' && String(entry.id) === id)
  }

  async function showAgents(signal: AbortSignal): Promise<CommandResult> {
    const display = displayServices(ctx)
    if (display === undefined) return { kind: 'error', text: t('agents panel is unavailable: the Mayfly screen is not mounted') }
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
    const entries = withLiveMetrics(ctx, listed, workflowLabels)
    const byId = new Map(entries.map(entry => [String(entry.id), entry]))
    const expanded = new Set<string>()
    let restore: (() => void) | undefined
    let restoreConfirm: (() => void) | undefined
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      offAgent()
      restoreConfirm?.()
      restoreConfirm = undefined
      restore?.()
      restore = undefined
      closeOpenBrowser = undefined
    }
    const offAgent = ctx.mayflyCurrentAgent.subscribe(next => {
      if (next !== parent) close()
    })
    const browser = new CanonicalSelectController({
      keymap: display.keymap,
      theme: display.theme,
      components: display.components,
      rows: buildAgentRows(entries, expanded),
      title: t('Subagents'),
      suppressAutomaticContextHints: true,
      contextHints: [
        { id: 'navigate', keys: `${interactionKeyHint(display.keymap, ACTION_MOVE_UP, '↑')}${interactionKeyHint(display.keymap, ACTION_MOVE_DOWN, '↓')}`, label: 'select', priority: 90 },
        {
          id: 'activate',
          keys: `${interactionKeyHint(display.keymap, ACTION_SUBMIT, 'Enter')} view · ${interactionKeyHint(display.keymap, ACTION_TOGGLE, 'Space')} expand · ${interactionKeyHint(display.keymap, ACTION_DELETE, 'Delete')}`,
          label: 'stop',
          compact: interactionKeyHint(display.keymap, ACTION_SUBMIT, 'Enter'),
          priority: 100,
        },
        { id: 'dismiss', keys: interactionKeyHint(display.keymap, ACTION_CANCEL, 'Esc'), label: 'close', priority: 95 },
      ],
      t,
      onToggle: row => {
        const entry = byId.get(row.value)
        if (entry?.kind !== 'child' || !entry.hasChildren) return
        if (expanded.has(row.value)) expanded.delete(row.value)
        else expanded.add(row.value)
        browser.setRows(buildAgentRows(entries, expanded))
      },
      onSelect: row => {
        const entry = byId.get(row.value)
        if (entry?.kind !== 'child') return
        close()
        ctx.mayflyCurrentAgent.openAuxiliary({
          kind: 'subagent',
          sessionId: String(entry.id),
          parentSessionId: String(entry.parentId),
          label: entry.label ?? String(entry.id),
          mode: entry.mode,
        })
      },
      onDelete: row => {
        const entry = byId.get(row.value)
        if (entry?.kind !== 'child') return
        if (entry.mode !== 'continuable') {
          getSharedEditor(ctx)?.notice?.(display.colors.warning('one-shot subagents cannot be stopped from the browser'))
          return
        }
        restoreConfirm?.()
        const form = new CanonicalFormController({
          keymap: display.keymap,
          theme: display.theme,
          components: display.components,
          title: 'Stop subagent',
          subtitle: `type y to stop ${entry.label ?? String(entry.id)}`,
          fields: [{
            id: 'yes',
            label: `Stop ${String(entry.id)}?`,
            required: true,
            validate: value => value.toLowerCase() === 'y' ? undefined : 'type y to confirm, or Esc to cancel',
          }],
          onSubmit: () => {
            restoreConfirm?.()
            restoreConfirm = undefined
            close()
            void stopEntry(entry).then(result => {
              const paint = result.kind === 'error' ? display.colors.error : (text: string) => text
              getSharedEditor(ctx)?.notice?.(paint(result.text))
            })
          },
          onCancel: () => {
            restoreConfirm?.()
            restoreConfirm = undefined
          },
        })
        restoreConfirm = mountEditorReplacement(ctx, form)
      },
      onCancel: close,
    })
    restore = mountEditorReplacement(ctx, browser)
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
      const parent = ctx.mayflyCurrentAgent.primary()
      if (parent === null) return { kind: 'error', text: t('no session is live yet') }
      ctx.mayflyCurrentAgent.closeAuxiliary()
      let entry: SubagentDescendantListEntry | undefined
      try {
        entry = await findEntry(parent.id, match[1]!, invocation.signal)
      } catch (error) {
        return { kind: 'error', text: describe(error) }
      }
      if (entry === undefined) return { kind: 'error', text: `unknown subagent: ${match[1]!}` }
      return stopEntry(entry)
    },
  })
  ctx.effect(() => () => {
    unloaded = true
    closeOpenBrowser?.()
    command()
  })
}
