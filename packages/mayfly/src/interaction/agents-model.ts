/** Readonly rc.2 descendant tree and stop confirmation presentation. @module */
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compactElapsedMs } from '../transcript/agent-presentation.ts'
import { outputCounter } from '../transcript/output-rate.ts'
import { formatTokens } from './usage.ts'

/** Native row plus optional metrics and stream phase from a currently resident child. */
export type MayflySubagentTreeEntry = SubagentDescendantListEntry & {
  readonly tokens?: number | undefined
  readonly toolCount?: number | undefined
  readonly liveChars?: number | undefined
  readonly settledMs?: number | undefined
  readonly activeSince?: number | undefined
  readonly streamPhase?: 'thinking' | 'composing' | undefined
  readonly stopBlocked?: string | undefined
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
export function agentTreeItems(entries: readonly MayflySubagentTreeEntry[], now: number): readonly MayflyListItem[] {
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
    const blocked = entry.stopBlocked
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

/** The exact reference tree, slash filter, and selected-row stop declaration. */
export function agentsPanelModel(entries: readonly MayflySubagentTreeEntry[], now: number, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('Subagents'), escapeLabel: 'close', body: ui.stack.column([
    ui.list({ id: 'subagents', role: 'browse', tree: true, selectedIds: [], filterable: true, filterMode: 'slash', items: agentTreeItems(entries, now) }),
    ui.actions({ id: 'subagent-actions', items: [
      { id: 'stop', label: t('Stop selected'), hintLabel: t('stop'), key: 'x', hidden: true, intent: 'danger', confirm: { title: t('Stop selected subagent?'), detail: t('Its live Agent shuts down; the stored conversation stays browsable.'), confirmLabel: t('Stop'), tone: 'danger' }, selections: [{ pagePath: [], controlId: 'subagents' }] },
    ] }),
  ]) })
}
