/** Native request settlement after an admitted UI acknowledgement, with Fiber cancellation.
 * @module @ephemeral-ai/mayfly/interaction/request-overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyOverlayHandle, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { observeInteractionLocale } from './locale.ts'

export interface RequestOverlayOptions<Result> {
  readonly id: string
  readonly title: string | (() => string)
  readonly agent?: Agent
  readonly signal?: AbortSignal
  readonly dismissal?: 'confirm-dirty' | 'discard'
  /** Yield scroll keys the surface does not need to the content region behind it. */
  readonly contentScroll?: boolean
  readonly view: () => MayflyUiNode
  readonly answer: (event: MayflyUiActionEvent) => Result | undefined
  /** Auxiliary settlement for events `answer` leaves open, e.g. navigation or side-effecting actions. */
  readonly onAction?: (event: MayflyUiActionEvent, context: MayflyUiEventContext) => MayflyUiActionReply | undefined | Promise<MayflyUiActionReply | undefined>
  readonly accepted?: (answer: Result) => void
  readonly cancelled: (reason: 'dismiss' | 'abort' | 'unload' | 'stale') => Result
}

/** Own only the pending native result; drafts, navigation, and input belong to shared UI. */
export function requestOverlay<Result>(ctx: Context, options: RequestOverlayOptions<Result>): { readonly result: Promise<Result>, readonly cancel: () => void } {
  let cancel!: () => void
  const result = new Promise<Result>((resolve, reject) => {
    let settled = false
    let candidate: { readonly operationId: string, readonly value: Result, readonly signal: AbortSignal } | undefined
    let handle: MayflyOverlayHandle | undefined
    let cleanup: (() => void) | undefined
    const finish = (complete: () => Result): void => {
      if (settled) return
      settled = true
      candidate = undefined
      cleanup?.()
      handle?.close()
      try { resolve(complete()) } catch (error) { reject(error) }
    }
    const stop = (reason: Parameters<typeof options.cancelled>[0]) => finish(() => options.cancelled(reason))
    cancel = () => stop('unload')
    const isCurrent = () => options.agent === undefined || ctx.mayflyCurrentAgent.current() === options.agent
    if (options.signal?.aborted) { stop('abort'); return }
    if (!isCurrent()) { stop('stale'); return }
    const source = [{ resourceId: options.id, revision: 1 }]
    const frame = (child: MayflyUiNode): MayflyUiNode => ({ kind: 'surface', chrome: 'overlay', padding: 1, title: typeof options.title === 'string' ? options.title : options.title(), child })
    const snapshot = (): MayflyUiNode => frame(options.view())
    handle = ctx.mayflyOverlays.open({
      id: options.id, presentation: 'editor', capturing: true,
      ...options.dismissal === undefined ? {} : { dismissal: options.dismissal },
      ...options.contentScroll === undefined ? {} : { contentScroll: options.contentScroll },
      scope: options.agent === undefined ? { kind: 'app', targetId: options.id } : { kind: 'session', sessionId: options.agent.id },
      source,
      onEvent: { action: async (event, context) => {
        if (settled || context.signal.aborted) return { kind: 'cancelled' }
        if (options.signal?.aborted || !isCurrent()) { stop(options.signal?.aborted ? 'abort' : 'stale'); return { kind: 'cancelled' } }
        if (event.kind === 'dismiss') { stop('dismiss'); return { kind: 'cancelled' } }
        if (candidate !== undefined && !candidate.signal.aborted) return { kind: 'cancelled' }
        const value = options.answer(event)
        if (value === undefined) {
          const reply = await options.onAction?.(event, context)
          /* Auxiliary replies publish bare content nodes; the request chrome
             (frame + title) is part of the overlay, not of the view. */
          if (reply !== undefined && 'node' in reply && reply.node !== undefined && reply.node !== null && reply.node.kind !== 'surface') return { ...reply, node: frame(reply.node) }
          return reply ?? { kind: 'completed' }
        }
        candidate = { operationId: context.operationId, value, signal: context.signal }
        return { kind: 'accepted', node: snapshot(), source, dismiss: true }
      } },
    }, snapshot())
    const offRegistry = ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'remove' && delta.id === options.id && handle?.closed) { stop(options.signal?.aborted ? 'abort' : 'unload'); return }
      if (delta.kind !== 'upsert' || delta.entry.id !== options.id || delta.entry.update.reason !== 'ack' || delta.entry.update.operationId !== candidate?.operationId) return
      if (options.signal?.aborted || !isCurrent()) { stop(options.signal?.aborted ? 'abort' : 'stale'); return }
      const value = candidate.value
      finish(() => {
        if (options.signal?.aborted || !isCurrent()) return options.cancelled(options.signal?.aborted ? 'abort' : 'stale')
        options.accepted?.(value)
        return value
      })
    })
    const offLocale = observeInteractionLocale(ctx, () => { handle!.set(snapshot()) })
    const offAgent = options.agent === undefined ? () => {} : ctx.mayflyCurrentAgent.subscribe(() => { if (!isCurrent()) stop('stale') })
    const onAbort = () => stop('abort')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    cleanup = ctx.effect(() => () => {
      offRegistry(); offLocale(); offAgent(); options.signal?.removeEventListener('abort', onAbort)
      cancel()
    })
  })
  return { result, cancel: () => cancel() }
}
