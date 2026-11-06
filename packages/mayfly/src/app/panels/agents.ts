/**
 * The Agents view: one member per spawn call of the displayed conversation, what the status item counts, and the rows of
 * its panel. The members come from the parent's own facts and child states, so the item needs no read of the tree; the
 * tree only adds the figures of a row while the view is open.
 * @module @ephemeral-ai/mayfly/app/panels/agents
 */

import type { ConversationAgentCall } from '@ephemeral-ai/mayfly-host/types'
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyPaneSummary, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySubagentTreeEntry } from '../../hosts/host-contract.ts'
import { compactElapsedMs } from '../../transcript/agent-presentation.ts'
import { partialStrings } from '../../transcript/partial-json.ts'
import { formatTokens } from '../../transcript/status-context-model.ts'
import type { SpawnedChildren } from '../../transcript/tool-calls.ts'
import { remoteOutputRate } from '../status/activity.ts'
import { remoteItemSummary, remoteViewList } from './view-items.ts'

/** The list control of the panel. */
export const AGENTS_VIEW_LIST_ID = 'agents-view'
/** The stop action of the panel. */
export const AGENTS_VIEW_STOP_ID = 'agents-view-stop'

type ChildEntry = Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>

/** One subagent of the conversation. */
export interface AgentMember {
  /** The spawn call's id, which names the row until the child is known. */
  readonly callId: string
  readonly childId?: string
  readonly label: string
  readonly state: 'running' | 'completed' | 'failed' | 'stopped'
  readonly startedAt: number
  readonly endedAt?: number
}

/** The first non-empty task a spawn call gave, else the tool's own name. */
function labelOf(call: ConversationAgentCall): string {
  const fields = partialStrings(call.arguments).fields
  return fields['description'] ?? fields['label'] ?? call.name
}

/**
 * The subagents of a conversation, in spawn order.
 * @param calls - the parent's spawn calls.
 * @param children - the states of the children the parent's catalog names.
 * @returns the members.
 */
export function agentMembers(calls: readonly ConversationAgentCall[], children: SpawnedChildren | undefined): readonly AgentMember[] {
  return calls.map((call): AgentMember => {
    const childId = children?.byCall.get(call.callId)
    const child = childId === undefined ? undefined : children?.byId.get(childId)
    const base = { callId: call.callId, ...childId === undefined ? {} : { childId }, label: labelOf(call), startedAt: call.startedAt }
    if (call.result === undefined) return { ...base, state: 'running' }
    if (call.result.isError) return { ...base, state: 'failed', endedAt: call.result.endedAt }
    if (child?.state === 'running') return { ...base, state: 'running' }
    if (child?.state !== 'settled') return { ...base, state: 'completed', endedAt: call.result.endedAt }
    return { ...base, state: child.stopped === true ? 'stopped' : child.failed ? 'failed' : 'completed', endedAt: child.endedAt ?? call.result.endedAt }
  })
}

const isLive = (member: AgentMember): boolean => member.state === 'running'

/** Whether any member still works. */
export function agentsLive(members: readonly AgentMember[]): boolean {
  return members.some(isLive)
}

/**
 * The item in the status row: `● agents 1/3`, settled over all; it stays for the conversation.
 * @param members - the members.
 * @param t - the translator.
 * @returns the summary, absent with no members.
 */
export function agentsSummary(members: readonly AgentMember[], t: MayflyTranslate): MayflyPaneSummary | null {
  if (members.length === 0) return null
  const settled = members.filter(member => !isLive(member)).length
  const mark: MayflyInlineSpan = agentsLive(members) ? { text: '●', tone: 'accent' }
    : members.some(member => member.state === 'failed') ? { text: '✕', tone: 'danger' } : { text: '✓', tone: 'success' }
  return { node: remoteItemSummary(mark, t('agents'), settled, members.length) }
}

const MARKS: Readonly<Record<AgentMember['state'], MayflyInlineSpan>> = {
  running: { text: '●', tone: 'accent' },
  completed: { text: '✓', tone: 'success' },
  failed: { text: '✕', tone: 'danger' },
  stopped: { text: '⊘', tone: 'muted' },
}

/** What a row says it does: its live activity, or how it ended when that is not plain from the mark. */
function activityOf(member: AgentMember, entry: ChildEntry | undefined, t: MayflyTranslate): string {
  if (member.state === 'failed') return t('failed')
  if (member.state === 'stopped') return t('stopped')
  if (member.state === 'completed') return ''
  if (entry?.currentTool !== undefined) return t('Using {tool}', { tool: entry.currentTool })
  return t(entry?.streamPhase === 'composing' ? 'Writing…' : 'Thinking…')
}

/** The figures at the right edge: in, out, the rate while it streams, and the time last. A figure not there yet is left out. */
function figuresOf(member: AgentMember, entry: ChildEntry | undefined, now: number): readonly MayflyInlineSpan[] {
  const estimate = Math.floor((entry?.liveChars ?? 0) / 4)
  const out = (entry?.outputTokens ?? 0) + (isLive(member) ? estimate : 0)
  const rate = isLive(member) ? remoteOutputRate(entry?.outputProgress, now) : ''
  const counts = [
    entry?.inputTokens === undefined || entry.inputTokens === 0 ? undefined : `↑${formatTokens(entry.inputTokens)}`,
    out === 0 ? undefined : `↓${formatTokens(out)}`,
    rate === '' ? undefined : rate,
  ].filter((part): part is string => part !== undefined)
  const time = compactElapsedMs(Math.max(0, (member.endedAt ?? now) - member.startedAt))
  return [{ text: [...counts.length === 0 ? [] : [counts.join('  ')], time].join(' · '), tone: 'muted' }]
}

function rowOf(member: AgentMember, entry: ChildEntry | undefined, blocked: string | undefined, now: number, t: MayflyTranslate): MayflyListItem {
  const activity = activityOf(member, entry, t)
  return {
    id: member.childId ?? member.callId,
    label: member.label,
    labelSpans: [MARKS[member.state], { text: ' ' }],
    cells: [
      { spans: [{ text: member.label }], max: 32 },
      { spans: activity === '' ? [] : [{ text: activity, tone: member.state === 'failed' ? 'danger' : 'muted' }], shed: 1 },
    ],
    right: figuresOf(member, entry, now),
    ...member.childId === undefined ? { disabled: true } : {},
    ...blocked === undefined ? {} : { unavailableActions: { [AGENTS_VIEW_STOP_ID]: blocked } },
  }
}

/**
 * The panel: every subagent, live ones first, then the finished, each in spawn order.
 * @param members - the members.
 * @param tree - the last read of the native tree, for the figures.
 * @param blockedText - why the native stop would refuse a row, translated.
 * @param now - the time.
 * @param t - the translator.
 * @returns the panel, absent with no members.
 */
export function agentsPanel(members: readonly AgentMember[], tree: readonly MayflySubagentTreeEntry[], blockedText: (entry: ChildEntry | undefined, member: AgentMember) => string | undefined, now: number, t: MayflyTranslate): MayflyUiNode | null {
  if (members.length === 0) return null
  const byId = new Map(tree.flatMap(entry => entry.kind === 'child' ? [[String(entry.id), entry] as const] : []))
  const entryOf = (member: AgentMember): ChildEntry | undefined => member.childId === undefined ? undefined : byId.get(member.childId)
  const ordered = [...members.filter(isLive), ...members.filter(member => !isLive(member))]
  return remoteViewList(AGENTS_VIEW_LIST_ID, ordered.map(member => rowOf(member, entryOf(member), blockedText(entryOf(member), member), now, t)), ui.actions({
    id: 'agents-view-actions',
    items: [{
      id: AGENTS_VIEW_STOP_ID,
      label: t('stop'),
      hidden: true,
      semantic: 'delete',
      hintLabel: t('stop'),
      selections: [{ pagePath: [], controlId: AGENTS_VIEW_LIST_ID }],
      confirm: { title: t('Stop selected subagent?'), detail: t('Its live Agent shuts down; the stored conversation stays browsable.'), confirmLabel: t('Stop'), tone: 'danger' },
    }],
  }))
}
