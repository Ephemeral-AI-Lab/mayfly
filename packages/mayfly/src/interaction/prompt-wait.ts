/**
 * The prompt's waits. A wait that can take a moment (the clipboard read behind Ctrl+V, the file search behind `@`) tells
 * the notification pane, which shows the unified loader with its words; one that ends before {@link SHOW_AFTER_MS} is
 * never shown, so a quick answer does not flash a spinner. Waits of several plugins stack: the newest shown one speaks,
 * and the loader leaves when the last one ends. The state is the tree's (`InteractionStateService`), so a reload of one
 * plugin does not strand a wait.
 *
 * @module @ephemeral-ai/mayfly/interaction/prompt-wait
 */

import type { Context } from '@deepseek-ai/cordis'

/** How long a wait lasts before the loader appears. */
const SHOW_AFTER_MS = 150

/** The waits in flight, newest last; `shown` once the delay has passed. */
export interface PromptWaits {
  readonly active: Array<{ readonly message: string, shown: boolean, timer: ReturnType<typeof setTimeout> | undefined }>
}

/** Tell the pane what the prompt awaits now: the newest wait that has been shown, or nothing. */
function publish(ctx: Context, waits: PromptWaits): void {
  const shown = waits.active.findLast(wait => wait.shown)
  ctx.emit('mayfly/prompt-wait-changed', shown?.message)
}

/**
 * Begin a wait of the prompt.
 * @param ctx - the plugin context that owns the wait; its tree's state holds it.
 * @param message - the translated words the loader shows (`Reading the clipboard…`).
 * @returns the function that ends the wait; safe to call twice.
 */
export function beginPromptWait(ctx: Context, message: string): () => void {
  const waits = ctx.mayflyInteractionState.promptWaits
  const wait: PromptWaits['active'][number] = { message, shown: false, timer: undefined }
  waits.active.push(wait)
  wait.timer = setTimeout(() => {
    wait.timer = undefined
    if (!waits.active.includes(wait)) return
    wait.shown = true
    publish(ctx, waits)
  }, SHOW_AFTER_MS)
  return () => {
    const index = waits.active.indexOf(wait)
    if (index < 0) return
    if (wait.timer !== undefined) clearTimeout(wait.timer)
    waits.active.splice(index, 1)
    if (wait.shown) publish(ctx, waits)
  }
}
