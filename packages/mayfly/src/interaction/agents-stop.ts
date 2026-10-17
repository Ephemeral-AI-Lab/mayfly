/**
 * Stopping a continuable subagent: the one path `/agents stop`, the `/agents` browser, and the Agents item of the status
 * row share. It re-reads the native catalog, applies the native checks (continuable, no live descendants, a live Agent
 * and a live direct parent), closes the child's conversation, and drains the child through its exact direct parent.
 *
 * @module @ephemeral-ai/mayfly/interaction/agents-stop
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { conversationId } from '../app/conversation-views.ts'

/** Outcome of a stop request. */
export type AgentStopResult = Readonly<{ kind: 'success' | 'error', text: string }>

/** Message of a thrown value. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function descendantStopError(entry: SubagentDescendantListEntry, count: number): AgentStopResult | undefined {
  if (count === 0) return undefined
  return {
    kind: 'error',
    text: `subagent ${String(entry.id)} owns ${String(count)} live descendant${count === 1 ? '' : 's'}; stop its live descendants first`,
  }
}

/**
 * Why a row cannot be stopped, in the words the row shows, or `undefined` when it can. Mirrors the native checks of
 * {@link stopSubagent} so a row explains itself before the confirm.
 * @param ctx - plugin context; needs `agents`.
 * @param t - translator for the reason.
 * @param entries - the catalog rows the child belongs to.
 * @param entry - the child.
 * @returns the reason, or `undefined`.
 */
export function stopBlockedReason(
  ctx: Context,
  t: MayflyTranslate,
  entries: readonly SubagentDescendantListEntry[],
  entry: Extract<SubagentDescendantListEntry, { readonly kind: 'child' }>,
): string | undefined {
  if (entry.mode === 'external') return t('Only continuable subagents can be stopped')
  if (entry.mode !== 'continuable') return t('Only continuable subagents can be stopped')
  if (ctx.agents.get(entry.id) === undefined) return t('Not live; there is nothing to stop')
  return liveAgentDescendantCount(entries, String(entry.id), candidate => ctx.agents.get(candidate.id) !== undefined) > 0
    ? t('Stop its live descendants first')
    : undefined
}

/**
 * Stop one subagent of the primary Agent's catalog.
 * @param ctx - plugin context; needs `subagents`, `agents`, `mayflyCurrentAgent`, and `mayflyConversations`.
 * @param entryId - the child's session id.
 * @param signal - cancellation of the catalog read.
 * @param t - translator for the one localized message.
 * @param unloaded - whether the caller's Fiber has unloaded.
 * @returns the outcome with its message.
 */
export async function stopSubagent(
  ctx: Context,
  entryId: string,
  signal: AbortSignal,
  t: MayflyTranslate,
  unloaded: () => boolean,
): Promise<AgentStopResult> {
  const primary = ctx.mayflyCurrentAgent.primary()
  if (primary === null) return { kind: 'error', text: t('no session is live yet') }
  let latest: readonly SubagentDescendantListEntry[]
  try {
    latest = await ctx.subagents.listDescendants(primary.id, signal)
  } catch (error) {
    return { kind: 'error', text: describe(error) }
  }
  if (unloaded() || ctx.mayflyCurrentAgent.primary() !== primary) {
    return { kind: 'error', text: `subagent ${entryId} stop request is stale` }
  }
  const current = latest.find(candidate => candidate.kind === 'child' && String(candidate.id) === entryId)
  if (current?.kind !== 'child') return { kind: 'error', text: `unknown subagent: ${entryId}` }
  if (current.mode === 'external') {
    return { kind: 'error', text: `subagent ${String(current.id)} is external; it has no local Agent to stop` }
  }
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
  ctx.mayflyConversations.close(conversationId(String(current.id)))
  try {
    await ctx.subagents.drainChildren(directParent, [current.id])
    return { kind: 'success', text: `stopped subagent ${String(current.id)}` }
  } catch (error) {
    return { kind: 'error', text: `could not stop subagent ${String(current.id)}: ${describe(error)}` }
  }
}
