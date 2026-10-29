/**
 * Generation-owned ordinary Mayfly overlay panels for Remote feature browsers.
 * @module @ephemeral-ai/mayfly/remote/panels/browser
 */

import type {
  MayflyOverlayHandle,
  MayflyUiActionEvent,
  MayflyUiActionReply,
  MayflyUiEventContext,
  MayflyUiNode,
  MayflyUiObservationEvent,
  MayflyUiScope,
} from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from '../features.ts'

/** One live browser overlay and its feature-owned refresh/close operations. */
export interface RemoteBrowserPanel {
  readonly closed: boolean
  refresh(): void
  close(): void
}

/** Ordinary browser callbacks; observations never publish or dismiss by themselves. */
export interface RemoteBrowserOptions {
  readonly id: string
  readonly scope: MayflyUiScope
  readonly isCurrent: () => boolean
  readonly signal?: AbortSignal
  readonly view: () => MayflyUiNode
  readonly observe?: (event: MayflyUiObservationEvent) => void
  readonly action?: (event: MayflyUiActionEvent, context: MayflyUiEventContext) => MayflyUiActionReply | Promise<MayflyUiActionReply>
  readonly back?: () => boolean
  readonly onClosed?: () => void
}

/** Open one editor-presented panel whose close path releases only Frontend observation. */
export function openRemoteBrowser(options: RemoteFeatureContext, browser: RemoteBrowserOptions): RemoteBrowserPanel {
  let handle: MayflyOverlayHandle | undefined
  let cleanup: (() => void) | undefined
  let closed = false
  const source = [{ resourceId: browser.id, revision: 1 }]
  const finish = (): void => {
    if (closed) return
    closed = true
    cleanup?.()
  }
  const close = (): void => {
    if (closed) return
    if (handle === undefined || handle.closed) finish()
    else handle.close()
  }
  handle = options.ctx.mayflyOverlays.open({
    id: browser.id,
    presentation: 'editor',
    capturing: true,
    scope: browser.scope,
    source,
    dismissal: 'discard',
    onEvent: {
      observe: event => {
        if (!closed && browser.isCurrent()) browser.observe?.(event)
      },
      action: async (event, context) => {
        if (closed || context.signal.aborted || !browser.isCurrent()) return { kind: 'cancelled', dismiss: true }
        if (event.kind === 'dismiss') {
          if (browser.back?.() === true) return { kind: 'completed', dismiss: false }
          close()
          return { kind: 'completed' }
        }
        return await browser.action?.(event, context) ?? { kind: 'completed' }
      },
    },
  }, browser.view())
  const refresh = (): void => {
    if (!closed && handle?.closed === false && browser.isCurrent()) handle.set(browser.view(), { source })
  }
  const offRegistry = options.ctx.mayflyOverlays.subscribe((delta) => {
    if (delta.kind === 'remove' && delta.id === browser.id && handle?.closed) finish()
  })
  const offLocale = options.subscribeLocale(refresh)
  const abort = (): void => { close() }
  browser.signal?.addEventListener('abort', abort, { once: true })
  cleanup = options.ctx.effect(() => () => {
    offRegistry()
    offLocale()
    browser.signal?.removeEventListener('abort', abort)
    browser.onClosed?.()
  })
  if (handle.closed) finish()
  return {
    get closed() { return closed },
    refresh,
    close,
  }
}
