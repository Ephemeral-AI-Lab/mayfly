/** Native projection status entries using the published Mayfly footer renderer. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { buildModelStatusNode } from '@ephemeral-ai/mayfly/status-basic-model'
import { buildCwdStatusNode, shortenCwd } from '@ephemeral-ai/mayfly/status-cwd'
import { buildContextStatusNode, type ContextStatusValues } from '@ephemeral-ai/mayfly/status-context'
import { mountStatusFooter } from '@ephemeral-ai/mayfly/transcript'
import type { RemotePresentationFacts } from '../transcript/remote-model.ts'

/** One authoritative Client snapshot paired with the current presentation. */
export interface RemoteStatusSnapshot {
  readonly presentation: RemotePresentationFacts
  readonly values: Readonly<Record<string, unknown>>
}

/** Host-owned paths, including startup before any Session exists. */
export interface RemoteStatusOptions {
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
  const context = ctx.mayflyStatus.register({ id: 'mayfly.status.context', priority: 6, band: 'right', overflow: 'hide' })
  let disposed = false
  const signatures: string[] = []
  const refresh = (): void => {
    if (disposed) return
    const { presentation: facts, values } = read()
    const projected = values['modelSelection'] as { readonly next?: { readonly reasoningEffort?: string }, readonly lastUsed?: { readonly reasoningEffort?: string } } | undefined
    const selected = projected?.next ?? projected?.lastUsed
    const effort = selected === undefined ? (facts as RemotePresentationFacts & { readonly reasoningEffort?: string }).reasoningEffort : selected.reasoningEffort
    const nodes: readonly (MayflyStatusNode | null)[] = [
      buildModelStatusNode({
        model: facts.model ?? (facts.ref === undefined ? '' : 'no model'),
        ...facts.provider === undefined ? {} : { provider: facts.provider },
        ...effort === undefined ? {} : { effort },
      }),
      buildCwdStatusNode(shortenCwd(facts.cwd || options.directory?.() || '', options.home?.() ?? '')),
      buildContextStatusNode({ usage: values['tokenUsage'] as ContextStatusValues['usage'], pressure: values['contextPressure'] as ContextStatusValues['pressure'], breakdown: values['contextBreakdown'] as ContextStatusValues['breakdown'] }),
    ]
    for (const [index, registration] of [model, cwd, context].entries()) {
      const node = nodes[index]!
      const signature = JSON.stringify(node)
      if (signature === signatures[index]) continue
      signatures[index] = signature
      registration.set(node)
    }
  }
  refresh()
  const unmountFooter = mountStatusFooter(ctx, ctx.mayflyScreen)
  const release = ctx.effect(() => () => {
    disposed = true
    model.dispose()
    cwd.dispose()
    context.dispose()
  })
  return { refresh, async dispose() {
    await release()
    await unmountFooter()
  } }
}
