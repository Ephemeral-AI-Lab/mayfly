/**
 * `/btw` side-question Agent creation and conversation ownership. The live
 * Agent becomes the exact `mayflyCurrentAgent` while displayed, so the
 * ordinary transcript, status, panes, and editor render it without a second
 * view implementation; its history floor hides the inherited seed.
 *
 * @module @ephemeral-ai/mayfly/interaction/btw-command
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '../app/index.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-btw-command'

/** Native and app-owned services required by the side-question controller. */
export const inject = ['commands', 'mayflyConversations', 'mayflyCurrentAgent', 'mayflyRequests', 'agents', 'agentDefaultModel', 'agentPresets']

interface OwnedBtw {
  readonly handle: AgentHandle
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

/** Register `/btw` and bind every owned Agent to its BTW conversation. */
export function apply(ctx: Context): void {
  const commands = ctx.commands
  const conversations = ctx.mayflyConversations
  const currentAgent = ctx.mayflyCurrentAgent
  const requests = ctx.mayflyRequests
  const agents = ctx.agents
  const defaultModel = ctx.agentDefaultModel
  const presets = ctx.agentPresets
  const logger = ctx.logger
  let owned: OwnedBtw | undefined
  let pending: AbortController | undefined
  let generation = 0
  let unloaded = false

  const disposeOwned = (entry: OwnedBtw): Promise<void> => {
    if (owned === entry) owned = undefined
    entry.disposal ??= entry.handle.dispose().catch(error => {
      logger.warn(`could not dispose BTW Agent ${String(entry.handle.agent.id)}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return entry.disposal
  }

  const offView = conversations.subscribe((snapshot) => {
    const entry = owned
    if (entry === undefined || snapshot.views.some(view => view.kind === 'btw' && view.sessionId === String(entry.handle.agent.id))) return
    void disposeOwned(entry)
  })
  ctx.effect(() => offView)
  ctx.on('mayfly/request-close-conversation', () => {
    if (pending === undefined) return
    generation += 1
    pending.abort()
    pending = undefined
  })

  const close = (): CommandResult => {
    const id = openBtw(ctx)
    if (id === undefined) return { kind: 'error', text: 'no side question is open' }
    generation += 1
    pending?.abort()
    pending = undefined
    conversations.close(id)
    return { kind: 'success', text: 'dismissed the side question' }
  }

  const ask = async (question: string): Promise<CommandResult> => {
    if (question === '') return close()
    const parent = currentAgent.primary()
    if (parent === null) return { kind: 'error', text: 'no active session for a side question' }
    const requestGeneration = ++generation
    pending?.abort()
    const previous = openBtw(ctx)
    if (previous !== undefined) conversations.close(previous)
    const controller = new AbortController()
    pending = controller
    let handle: AgentHandle
    let historyFloorSeq: number | undefined
    try {
      // Inherit the parent's whole log: `buildForkSeed` tags the inherited cut
      // and closes any open tail, so a side question may start mid-turn.
      const events = parent.session.snapshotEvents()
      const lastSeq = events.at(-1)?.seq
      const seed = lastSeq === undefined ? [] : buildForkSeed(events, lastSeq)
      historyFloorSeq = lastSeq
      const selected = parent.session.requestHeader()?.config ?? defaultModel.currentSelection()
      let preset = parent.session.header.agentPreset
      for (const event of events) {
        if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
      }
      handle = await agents.create({
        sessionId: SessionId(`btw-${randomUUID()}`),
        meta: {
          cwd: parent.session.header.cwd ?? process.cwd(),
          parentSession: parent.id,
          ...(events.length === 0 ? {} : { isSeeded: true }),
        },
        ...(events.length === 0 ? {} : { inheritedEventCount: SessionLogOffset(events.length) }),
        seed,
        signal: controller.signal,
        agentOptions: {
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        },
        setup: async agentCtx => { await presets.mount(agentCtx, preset) },
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
    const entry: OwnedBtw = { handle, disposal: undefined }
    if (unloaded || controller.signal.aborted || requestGeneration !== generation
      || currentAgent.primary() !== parent) {
      await disposeOwned(entry)
      return { kind: 'error', text: 'the side question was replaced before it opened' }
    }
    owned = entry
    const id = conversations.open({
      kind: 'btw',
      sessionId: String(handle.agent.id),
      parentSessionId: String(parent.id),
      label: labelFor(question),
      ...(historyFloorSeq === undefined ? {} : { historyFloorSeq }),
    })
    const message = createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } })
    try {
      handle.agent.followup(message)
      requests.begin('btw')
    } catch (error) {
      conversations.close(id)
      await disposeOwned(entry)
      return { kind: 'error', text: `could not ask the side question: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { kind: 'success', text: 'asked the side question' }
  }

  ctx.effect(() => commands.register({
    name: 'btw',
    description: 'Ask a side question in a temporary Agent session',
    input: { hint: '<question>' },
    handler: invocation => ask(invocation.rawInput.trim()),
  }))

  ctx.effect(() => async () => {
    unloaded = true
    generation += 1
    pending?.abort()
    pending = undefined
    const entry = owned
    const id = openBtw(ctx)
    if (id !== undefined) conversations.close(id)
    if (entry !== undefined) await disposeOwned(entry)
  })
}
