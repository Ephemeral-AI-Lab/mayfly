/** Native projection status entries using the published Mayfly footer renderer. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { buildConversationStatus } from '../components/conversation-status.ts'
import { interactionTranslator } from '../interaction/locale.ts'
import { buildModelStatusNode } from '../transcript/model-status.ts'
import { buildCwdStatusNode, shortenCwd } from '../transcript/status-cwd-model.ts'
import { buildContextStatusNode, type ContextStatusValues } from '../transcript/status-context-model.ts'
import { focusModeNode } from '../transcript/status-focus.ts'
import { mountStatusFooter } from '../transcript/status-rows.ts'
import { transcriptTranslator } from '../transcript/locale.ts'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** One authoritative Client snapshot paired with the current presentation. */
export interface RemoteStatusSnapshot {
  readonly presentation: RemotePresentationFacts
  readonly values: Readonly<Record<string, unknown>>
  readonly conversation?: 'primary' | 'btw' | 'subagent' | undefined
  /** Cold side views have durable history but no Agent-backed context or effort. */
  readonly access?: 'interactive' | 'resumable' | 'readonly' | undefined
}

/** Host-owned paths, including startup before any Session exists. */
interface RemoteStatusOptions {
  readonly home?: () => string
  readonly directory?: () => string
}

/** Explicit refresh and early cleanup; the owning Fiber also releases every resource. */
export interface RemoteStatusHandle {
  refresh(): void
  dispose(): Promise<void>
}

/** Register native facts in the same row as feature and external-plugin entries. */
export function mountRemoteStatus(ctx: Context, read: () => RemoteStatusSnapshot, options: RemoteStatusOptions = {}): RemoteStatusHandle {
  const model = ctx.mayflyStatus.register({ id: 'mayfly.status.basic', priority: 0, overflow: 'truncate' })
  const cwd = ctx.mayflyStatus.register({ id: 'mayfly.status.cwd', priority: 7, overflow: 'truncate' })
  const conversation = ctx.mayflyStatus.register({ id: 'mayfly.status.conversation-view', priority: 1 })
  const focus = ctx.mayflyStatus.register({ id: 'mayfly.status.focus', priority: 1 }, null)
  const focusTranslate = transcriptTranslator(ctx, 'transcript')
  const t = interactionTranslator(ctx)
  const context = ctx.mayflyStatus.register({ id: 'mayfly.status.context', priority: 6, band: 'right', overflow: 'hide' })
  let disposed = false
  const signatures: string[] = []
  const published: (MayflyStatusNode | null)[] = []
  // A refresh runs for every presentation change; the shed builders clone
  // their nodes, so a node is rebuilt only when one of its inputs changed.
  const built: ({ readonly inputs: readonly unknown[], readonly node: MayflyStatusNode | null } | undefined)[] = []
  const memo = (index: number, inputs: readonly unknown[], build: () => MayflyStatusNode | null): MayflyStatusNode | null => {
    const prior = built[index]
    if (prior !== undefined && prior.inputs.every((input, at) => Object.is(input, inputs[at]))) return prior.node
    const node = build()
    built[index] = { inputs, node }
    return node
  }
  const refresh = (): void => {
    if (disposed) return
    const snapshot = read()
    const { presentation: facts, values } = snapshot
    const projected = values['modelSelection'] as {
      readonly next?: { readonly provider?: string, readonly model?: string, readonly reasoningEffort?: string } | null
      readonly lastUsed?: { readonly provider?: string, readonly model?: string, readonly reasoningEffort?: string } | null
    } | null | undefined
    const selected = projected?.next ?? projected?.lastUsed
    const matches = selected == null || selected.provider === facts.provider && selected.model === facts.model
    const live = snapshot.access === undefined || snapshot.access === 'interactive'
    const effort = live ? selected?.reasoningEffort ?? (matches ? facts.reasoningEffort : undefined) : undefined
    const modelName = facts.model ?? (facts.ref === undefined ? '' : 'no model')
    const directory = facts.cwd || options.directory?.() || ''
    const home = options.home?.() ?? ''
    const usage = values['tokenUsage'] as ContextStatusValues['usage']
    const pressure = values['contextPressure'] as ContextStatusValues['pressure']
    const breakdown = values['contextBreakdown'] as ContextStatusValues['breakdown']
    const nodes: readonly (MayflyStatusNode | null)[] = [
      memo(0, [modelName, facts.provider, effort], () => buildModelStatusNode({
        model: modelName,
        ...facts.provider === undefined ? {} : { provider: facts.provider },
        ...effort === undefined ? {} : { effort },
      })),
      memo(1, [directory, home], () => buildCwdStatusNode(shortenCwd(directory, home))),
      buildConversationStatus(snapshot.conversation, t),
      memo(3, [live, usage, pressure, breakdown], () => live ? buildContextStatusNode({ usage, pressure, breakdown }) : null),
    ]
    for (const [index, registration] of [model, cwd, conversation, context].entries()) {
      const node = nodes[index]!
      if (index in published && published[index] === node) continue
      published[index] = node
      const signature = JSON.stringify(node)
      if (signature === signatures[index]) continue
      signatures[index] = signature
      registration.set(node)
    }
  }
  refresh()
  const unmountFooter = mountStatusFooter(ctx, ctx.mayflyScreen)
  const release = ctx.effect(() => {
    const offFocus = ctx.on('mayfly/focus-mode-changed', mode => {
      if (!disposed) focus.set(focusModeNode(mode, focusTranslate))
    })
    return () => {
      disposed = true
      offFocus()
      model.dispose()
      cwd.dispose()
      conversation.dispose()
      context.dispose()
      focus.dispose()
    }
  })
  return { refresh, async dispose() {
    await release()
    await unmountFooter()
  } }
}
