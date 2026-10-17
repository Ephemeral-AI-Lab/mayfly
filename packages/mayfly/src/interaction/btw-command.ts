/**
 * `/btw` side-question ownership over one native fork activation. The fork
 * provider seeds the child from the parent's completed turns; the managed
 * activation accepts the question as its initial prompt and owns the child's
 * lifecycle, so closing the side conversation disposes that exact activation.
 * The live child becomes the exact `mayflyCurrentAgent` while displayed, so
 * the ordinary transcript, status, panes, and editor render it without a
 * second view implementation; its history floor hides the inherited seed.
 * `/btw` exists only while the native `fork` provider is registered; without
 * it no command is registered and no custom Agent is created.
 *
 * @module @ephemeral-ai/mayfly/interaction/btw-command
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '../app/index.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-btw-command'

/** Native and app-owned services required by the side-question controller. */
export const inject = ['commands', 'mayflyConversations', 'mayflyCurrentAgent', 'mayflyRequests', 'agents', 'subagents']

/** The native provider that seeds a side conversation from the parent's completed turns. */
const BTW_PROVIDER = 'fork'

/** The catalog label that marks the side-question child from `/agents`. */
const BTW_LABEL = 'btw'

interface OwnedBtw {
  readonly activation: SubagentActivation
  readonly viewId: string
  disposal: Promise<void> | undefined
}

function labelFor(question: string): string {
  const line = question.replace(/[\r\n]+/gu, ' ').trim()
  return line.length <= 60 ? line : `${line.slice(0, 57)}...`
}

/** The open BTW conversation, if any; the registry keeps at most one. */
function openBtw(ctx: Context): string | undefined {
  return ctx.mayflyConversations.snapshot().views.find(view => view.kind === 'btw')?.id
}

/** Register `/btw` while the native fork provider is composed. */
export function apply(ctx: Context): void {
  const commands = ctx.commands
  const conversations = ctx.mayflyConversations
  const currentAgent = ctx.mayflyCurrentAgent
  const requests = ctx.mayflyRequests
  const logger = ctx.logger
  let owned: OwnedBtw | undefined
  let pending: AbortController | undefined
  let generation = 0
  let unloaded = false
  let disposeCommand: (() => void) | undefined

  const disposeOwned = (entry: OwnedBtw): Promise<void> => {
    if (owned === entry) owned = undefined
    entry.disposal ??= entry.activation.dispose().catch(error => {
      logger.warn(`could not dispose BTW activation ${String(entry.activation.childId)}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return entry.disposal
  }

  const closeOwned = (): void => {
    const entry = owned
    if (entry === undefined) return
    conversations.close(entry.viewId)
    void disposeOwned(entry)
  }

  const offView = conversations.subscribe((snapshot) => {
    const entry = owned
    if (entry === undefined || snapshot.views.some(view => view.kind === 'btw' && view.sessionId === String(entry.activation.childId))) return
    void disposeOwned(entry)
  })
  ctx.effect(() => offView)
  ctx.effect(() => ctx.on('mayfly/request-close-conversation', () => {
    if (pending === undefined && owned === undefined) return
    generation += 1
    pending?.abort()
    pending = undefined
    closeOwned()
  }))

  const close = (): CommandResult => {
    if (pending === undefined && owned === undefined) return { kind: 'error', text: 'no side question is open' }
    generation += 1
    pending?.abort()
    pending = undefined
    closeOwned()
    return { kind: 'success', text: 'dismissed the side question' }
  }

  const ask = async (question: string): Promise<CommandResult> => {
    if (question === '') return close()
    const parent = currentAgent.primary()
    if (parent === null) return { kind: 'error', text: 'no active session for a side question' }
    if (!ctx.subagents.list().includes(BTW_PROVIDER)) return { kind: 'error', text: 'side questions need the native fork subagent provider' }
    const requestGeneration = ++generation
    pending?.abort()
    const previous = owned
    if (previous !== undefined) {
      conversations.close(previous.viewId)
      void disposeOwned(previous)
    }
    const controller = new AbortController()
    pending = controller
    let activation: SubagentActivation
    try {
      activation = await ctx.subagents.startActivation({
        provider: BTW_PROVIDER,
        label: BTW_LABEL,
        request: { parent, prompt: [{ type: 'text', text: question }] },
        delivery: 'caller',
        signal: controller.signal,
      })
    } catch (error) {
      if (pending === controller) pending = undefined
      if (unloaded || controller.signal.aborted || requestGeneration !== generation) {
        return { kind: 'error', text: 'the side question was replaced before it opened' }
      }
      return {
        kind: 'error',
        text: `could not start the side session: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (pending === controller) pending = undefined
    const entry: OwnedBtw = { activation, viewId: '', disposal: undefined }
    // The captured result belongs to the side conversation; teardown failures
    // are reported by dispose(), not by an unhandled rejection here.
    void activation.result.catch(error => {
      logger.warn(`BTW activation ${String(activation.childId)} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (unloaded || controller.signal.aborted || requestGeneration !== generation || currentAgent.primary() !== parent) {
      await disposeOwned(entry)
      return { kind: 'error', text: 'the side question was replaced before it opened' }
    }
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) {
      await disposeOwned(entry)
      return { kind: 'error', text: 'the side question was replaced before it opened' }
    }
    // The fork seed's inherited prefix is everything before the child's first
    // own event; presentation starts after that cut.
    const firstLive = Number(child.session.firstLiveSeq)
    const historyFloorSeq = firstLive > 0 ? firstLive - 1 : undefined
    let viewId: string
    try {
      viewId = conversations.open({
        kind: 'btw',
        sessionId: String(activation.childId),
        parentSessionId: String(parent.id),
        label: labelFor(question),
        ...(historyFloorSeq === undefined ? {} : { historyFloorSeq }),
      })
    } catch (error) {
      await disposeOwned(entry)
      return { kind: 'error', text: `could not open the side session: ${error instanceof Error ? error.message : String(error)}` }
    }
    const shown: OwnedBtw = { activation, viewId, disposal: undefined }
    owned = shown
    requests.begin('btw')
    return { kind: 'success', text: 'asked the side question' }
  }

  const syncCommand = (): void => {
    const available = !unloaded && ctx.subagents.list().includes(BTW_PROVIDER)
    if (available && disposeCommand === undefined) {
      disposeCommand = commands.register({
        name: 'btw',
        description: 'Ask a side question in a temporary Agent session',
        input: { hint: '<question>' },
        handler: invocation => ask(invocation.rawInput.trim()),
      })
      return
    }
    if (available || disposeCommand === undefined) return
    generation += 1
    pending?.abort()
    pending = undefined
    closeOwned()
    disposeCommand()
    disposeCommand = undefined
  }
  syncCommand()
  ctx.effect(() => ctx.on('subagent/provider-added', syncCommand))
  ctx.effect(() => ctx.on('subagent/provider-removed', syncCommand))

  ctx.effect(() => async () => {
    unloaded = true
    generation += 1
    pending?.abort()
    pending = undefined
    const entry = owned
    const id = openBtw(ctx)
    if (id !== undefined) conversations.close(id)
    if (entry !== undefined) await disposeOwned(entry)
    disposeCommand?.()
    disposeCommand = undefined
  })
}
