/** Signal cleanup for ordinary UI overlay registrations.
 * @module @ephemeral-ai/mayfly/interaction/ui-overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyOverlayDefinition, MayflyOverlayHandle, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Open-time policy for an app-scoped UI overlay registration. */
export interface UiOverlayOpenOptions {
  /** Caller cancellation: an aborted signal throws before opening; a later abort closes the overlay. */
  readonly signal?: AbortSignal | undefined
  /**
   * `'focus'` returns `undefined` and focuses the live overlay of the same id
   * (the picker idiom: re-running the command focuses the open surface);
   * `'replace'` closes a live same-id overlay first — the registry rejects a
   * duplicate id — then opens a fresh registration (the refresh-on-rerun
   * idiom, and the required policy for detail views that reuse one id
   * across items).
   */
  readonly reopen: 'focus' | 'replace'
  /**
   * Runs when the overlay is removed or the owning fiber unloads; release
   * extra listeners bound to the overlay's life here instead of subscribing
   * to the registry a second time.
   */
  readonly onClosed?: () => void
}

export function openUiOverlay(ctx: Context, definition: MayflyOverlayDefinition, node: MayflyUiNode, options: { readonly signal?: AbortSignal | undefined, readonly reopen: 'replace', readonly onClosed?: () => void }): MayflyOverlayHandle
export function openUiOverlay(ctx: Context, definition: MayflyOverlayDefinition, node: MayflyUiNode, options: UiOverlayOpenOptions): MayflyOverlayHandle | undefined
export function openUiOverlay(ctx: Context, definition: MayflyOverlayDefinition, node: MayflyUiNode, options: UiOverlayOpenOptions): MayflyOverlayHandle | undefined {
  options.signal?.throwIfAborted()
  const registry = ctx.get('mayflyOverlays')
  if (registry === undefined) throw new Error('Mayfly overlays are unavailable')
  if (options.reopen === 'focus' && registry.focus(definition.id)) return undefined
  if (options.reopen === 'replace') registry.close(definition.id)
  const handle = registry.open(definition, node)
  const abort = () => handle.close()
  let cleanup!: () => void
  const off = registry.subscribe(delta => { if (delta.kind === 'remove' && delta.id === definition.id && handle.closed) cleanup() })
  cleanup = ctx.effect(() => () => { off(); options.signal?.removeEventListener('abort', abort); options.onClosed?.() })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (handle.closed) cleanup()
  return handle
}
