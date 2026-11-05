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
  MayflySourceStamp,
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
  readonly dismissal?: 'confirm-dirty' | 'discard'
  readonly view: () => MayflyUiNode
  /** Native data and field revisions acknowledged by a structured form submit. */
  readonly source?: () => readonly MayflySourceStamp[]
  readonly observe?: (event: MayflyUiObservationEvent) => void
  readonly action?: (event: MayflyUiActionEvent, context: MayflyUiEventContext) => MayflyUiActionReply | Promise<MayflyUiActionReply>
  readonly back?: () => boolean
  readonly onClosed?: () => void
}

/** Open one editor-presented panel whose close path releases only Frontend observation. */
export function openRemoteBrowser(options: Pick<RemoteFeatureContext, 'ctx' | 'subscribeLocale'>, browser: RemoteBrowserOptions): RemoteBrowserPanel {
  let handle: MayflyOverlayHandle | undefined
  let closed = false
  const cleanups: Array<() => void> = []
  const fallbackSource = [{ resourceId: browser.id, revision: 1 }]
  const source = (): readonly MayflySourceStamp[] => browser.source?.() ?? fallbackSource
  const abort = (): void => { close() }
  const finish = options.ctx.effect(() => () => {
    if (closed) return
    closed = true
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    browser.signal?.removeEventListener('abort', abort)
    browser.onClosed?.()
  })
  const own = (cleanup: () => void): void => {
    if (closed) cleanup()
    else cleanups.push(cleanup)
  }
  const close = (): void => {
    if (closed) return
    if (handle === undefined || handle.closed) finish()
    else handle.close()
  }
  const refresh = (): void => {
    if (!closed && handle?.closed === false && browser.isCurrent()) handle.set(browser.view(), { source: source() })
  }
  const panel: RemoteBrowserPanel = {
    get closed() { return closed },
    refresh,
    close,
  }
  if (browser.signal?.aborted) {
    finish()
    return panel
  }
  browser.signal?.addEventListener('abort', abort, { once: true })
  handle = options.ctx.mayflyOverlays.open({
    id: browser.id,
    presentation: 'editor',
    capturing: true,
    scope: browser.scope,
    source: source(),
    dismissal: browser.dismissal ?? 'discard',
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
  if (closed || handle.closed) {
    handle.close()
    finish()
    return panel
  }
  own(options.ctx.mayflyOverlays.subscribe((delta) => {
    if (delta.kind === 'remove' && delta.id === browser.id && handle!.closed) finish()
  }))
  own(options.subscribeLocale(refresh))
  return panel
}
