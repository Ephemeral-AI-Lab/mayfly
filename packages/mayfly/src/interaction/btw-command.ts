/**
 * `/btw` side-question Agent creation and auxiliary-view ownership. The live
 * Agent becomes the exact `mayflyCurrentAgent`, so the ordinary transcript,
 * status, panes, and editor render it without a second view implementation.
 *
 * @module @ephemeral-ai/mayfly/interaction/btw-command
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '../app/index.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-btw-command'

/** Native and app-owned services required by the side-question controller. */
export const inject = ['commands', 'mayflyCurrentAgent', 'mayflyRequests', 'agents', 'agentDefaultModel', 'agentPresets']

interface OwnedBtw {
  readonly handle: AgentHandle
  disposal: Promise<void> | undefined
}

function labelFor(question: string): string {
  const line = question.replace(/[\r\n]+/gu, ' ').trim()
  return line.length <= 60 ? line : `${line.slice(0, 57)}...`
}

/** Register `/btw` and bind every owned Agent to the single auxiliary slot. */
export function apply(ctx: Context): void {
  const commands = ctx.commands
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

  const offView = currentAgent.subscribeView((snapshot) => {
    const entry = owned
    if (entry === undefined || snapshot.auxiliary?.sessionId === String(entry.handle.agent.id)) return
    void disposeOwned(entry)
  })
  ctx.effect(() => offView)
  ctx.on('mayfly/request-close-agent-view', () => {
    if (pending === undefined) return
    generation += 1
    pending.abort()
    pending = undefined
  })

  const close = (): CommandResult => {
    const view = currentAgent.view().auxiliary
    if (view?.kind !== 'btw') return { kind: 'error', text: 'no side question is open' }
    generation += 1
    pending?.abort()
    pending = undefined
    currentAgent.closeAuxiliary()
    return { kind: 'success', text: 'dismissed the side question' }
  }

  const ask = async (question: string): Promise<CommandResult> => {
    if (question === '') return close()
    const parent = currentAgent.primary()
    if (parent === null) return { kind: 'error', text: 'no active session for a side question' }
    const requestGeneration = ++generation
    pending?.abort()
    currentAgent.closeAuxiliary()
    const controller = new AbortController()
    pending = controller
    let handle: AgentHandle
    let transcriptAfterSeq: number | undefined
    try {
      const seed = parent.session.snapshotEvents()
      transcriptAfterSeq = seed.length === 0 ? undefined : seed.at(-1)!.seq
      const selected = parent.session.requestHeader()?.config ?? defaultModel.currentSelection()
      let preset = parent.session.header.agentPreset
      for (const event of seed) {
        if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
      }
      handle = await agents.create({
        sessionId: SessionId(`btw-${randomUUID()}`),
        meta: {
          cwd: parent.session.header.cwd ?? process.cwd(),
          parentSession: parent.id,
          ...(seed.length === 0 ? {} : { isSeeded: true }),
        },
        ...(seed.length === 0 ? {} : { inheritedEventCount: SessionLogOffset(seed.length) }),
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
      || currentAgent.current() !== parent) {
      await disposeOwned(entry)
      return { kind: 'error', text: 'the side question was replaced before it opened' }
    }
    owned = entry
    currentAgent.openAuxiliary({
      kind: 'btw',
      sessionId: String(handle.agent.id),
      parentSessionId: String(parent.id),
      label: labelFor(question),
      ...(transcriptAfterSeq === undefined ? {} : { transcriptAfterSeq }),
    })
    const message = createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } })
    try {
      handle.agent.followup(message)
      requests.begin('btw')
    } catch (error) {
      currentAgent.closeAuxiliary()
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
    if (currentAgent.view().auxiliary?.kind === 'btw') currentAgent.closeAuxiliary()
    if (entry !== undefined) await disposeOwned(entry)
  })
}
