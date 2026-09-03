/**
 * `mayfly-terminal-title` plugin: mirrors the session title onto the terminal
 * window/tab title through `mayflyScreen.setTitle` (the core OSC 0 emitter).
 * The title itself is generated upstream — the harness session-title
 * service derives it from the conversation with an auxiliary model (the
 * Mayfly bundle runs the all-prompts cadence, so it tracks the latest task)
 * — so this plugin mirrors the official `title` session projection through
 * `mayflySessionFacts`. It never receives an Agent or folds Harness events.
 *
 * Emission is deduped: the fold is re-derived cheaply on every event, but
 * an unchanged title writes nothing. No session, no service, or an
 * untitled session falls back to the product name `'mayfly'` (the kimi
 * PRODUCT_NAME shape); a missing screen silently skips — a plugin fiber
 * waiting on `mayflyScreen` never races the core plugin that provides it.
 * The renderer only receives the projection's readonly string.
 *
 * @module @ephemeral-ai/mayfly/interaction/terminal-title
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionFactsService } from '../transcript/index.ts'

/** The title shown while nothing is attached or titled yet. */
export const PRODUCT_TITLE = 'mayfly'

/** Stable Cordis plugin name. */
export const name = 'mayfly-terminal-title'

/** The terminal mirror requires the screen; everything else resolves lazily. */
export const inject = ['mayflyScreen', 'mayflySessionFacts']

/**
 * Derive the title text to mirror: the given session's folded title, or
 * {@link PRODUCT_TITLE} while no agent is attached, the service is absent
 * (a thin host), or the session is not yet titled.
 * @param title - the current renderer-neutral title fact.
 * @returns the text for the terminal title.
 */
export function currentTitleText(title: string | undefined): string {
  return title !== undefined && title.length > 0 ? title : PRODUCT_TITLE
}

/**
 * Mirror the session title onto the terminal window title, re-emitting
 * only when the derived text actually changed.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService
  let emitted: string | undefined

  const emit = (title: string | undefined): void => {
    const next = currentTitleText(title)
    if (next === emitted) return
    emitted = next
    ctx.mayflyScreen.setTitle(next)
  }

  const offTitle = facts.subscribeTitle(emit)
  ctx.effect(() => () => offTitle())
}
