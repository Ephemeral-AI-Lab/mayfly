/**
 * Acknowledged Remote request overlays with selection, cancellation, and hide-only dismissal.
 * @module @ephemeral-ai/mayfly/remote/interactions/request-overlay
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui/provider'
import type {
  MayflyOverlayHandle,
  MayflyUiActionEvent,
  MayflyUiActionReply,
  MayflyUiEventContext,
  MayflyUiNode,
  MayflyUiScope,
} from '@ephemeral-ai/mayfly-ui'

type RemoteRequestCancellation = 'dismiss' | 'abort' | 'unload' | 'stale'

interface RemoteRequestOverlayOptions<Result> {
  readonly id: string
  readonly title: string
  readonly scope: MayflyUiScope
  readonly isCurrent: () => boolean
  readonly subscribeLocale: (listener: () => void) => () => void
  readonly signal?: AbortSignal
  readonly dismissal?: 'confirm-dirty' | 'discard'
  readonly contentScroll?: boolean
  readonly bare?: boolean
  readonly armMs?: number
  /** Hide this request without settling it; reveal() restores the same draft and overlay generation. */
  readonly hideOnDismiss?: boolean
  /** Observe hide-only dismissal so the owner can preserve the card without showing it. */
  readonly onHidden?: () => void
  readonly view: () => MayflyUiNode
  readonly answer: (event: MayflyUiActionEvent) => Result | undefined
  readonly onAction?: (event: MayflyUiActionEvent, context: MayflyUiEventContext) => MayflyUiActionReply | undefined | Promise<MayflyUiActionReply | undefined>
  readonly cancelled: (reason: RemoteRequestCancellation) => Result
}

export interface RemoteRequestOverlay<Result> {
  readonly result: Promise<Result>
  /** End through the owner's local teardown path; this never represents a user answer. */
  cancel: () => void
  refresh: () => void
  /** Reveal a hide-on-dismiss overlay with its existing draft. */
  reveal: () => void
}

/** Own only pending native settlement; the shared Mayfly UI model owns drafts and acknowledgement. */
export function requestOverlay<Result>(ctx: Context, options: RemoteRequestOverlayOptions<Result>): RemoteRequestOverlay<Result> {
  let cancel!: () => void
  let refresh: () => void = () => {}
  let reveal: () => void = () => {}
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
    const stop = (reason: RemoteRequestCancellation): void => finish(() => options.cancelled(reason))
    cancel = () => stop('unload')
    if (options.signal?.aborted) { stop('abort'); return }
    if (!options.isCurrent()) { stop('stale'); return }
    const source = [{ resourceId: options.id, revision: 1 }]
    const frame = (child: MayflyUiNode): MayflyUiNode => options.bare === true ? child : { kind: 'surface', chrome: 'overlay', padding: 1, title: options.title, child }
    const snapshot = (): MayflyUiNode => frame(options.view())
    handle = ctx.mayflyOverlays.open({
      id: options.id,
      presentation: 'editor',
      capturing: true,
      scope: options.scope,
      source,
      ...options.dismissal === undefined ? {} : { dismissal: options.dismissal },
      ...options.contentScroll === undefined ? {} : { contentScroll: options.contentScroll },
      ...options.armMs === undefined ? {} : { armMs: options.armMs },
      onEvent: { action: async (event, context) => {
        // The native UI endpoint invokes only live, uncancelled actions. Its
        // generation also fences completion after an asynchronous onAction.
        if (!options.isCurrent()) { stop('stale'); return { kind: 'cancelled' } }
        if (event.kind === 'dismiss') {
          if (options.hideOnDismiss === true) {
            handle?.hide()
            options.onHidden?.()
            return { kind: 'cancelled', dismiss: false }
          }
          stop('dismiss')
          return { kind: 'cancelled' }
        }
        if (candidate !== undefined && !candidate.signal.aborted) return { kind: 'cancelled' }
        const value = options.answer(event)
        if (value === undefined) {
          const reply = await options.onAction?.(event, context)
          if (reply !== undefined && 'node' in reply && reply.node.kind !== 'surface') return { ...reply, node: frame(reply.node) }
          return reply ?? { kind: 'completed' }
        }
        candidate = { operationId: context.operationId, value, signal: context.signal }
        return { kind: 'accepted', node: snapshot(), source, dismiss: true }
      } },
    }, snapshot())
    const offRegistry = ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'remove' && delta.id === options.id && handle?.closed) { stop('unload'); return }
      if (delta.kind !== 'upsert' || delta.entry.id !== options.id || delta.entry.update.reason !== 'ack' || delta.entry.update.operationId !== candidate?.operationId) return
      if (!options.isCurrent()) { stop('stale'); return }
      const value = candidate.value
      finish(() => {
        if (options.signal?.aborted || !options.isCurrent()) return options.cancelled(options.signal?.aborted ? 'abort' : 'stale')
        return value
      })
    })
    refresh = () => { if (!settled) handle!.set(snapshot()) }
    reveal = () => {
      if (settled) return
      handle!.show()
      handle!.focus()
    }
    const offLocale = options.subscribeLocale(refresh)
    const onAbort = () => stop('abort')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    cleanup = ctx.effect(() => () => {
      offRegistry()
      offLocale()
      options.signal?.removeEventListener('abort', onAbort)
      cancel()
    })
    // A provider or locale subscriber can synchronously abort while opening;
    // installing the listener alone would miss that already-fired event.
    if (options.signal?.aborted) onAbort()
  })
  return { result, cancel: () => cancel(), refresh: () => refresh(), reveal: () => reveal() }
}
