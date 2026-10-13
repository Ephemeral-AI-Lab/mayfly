/**
 * The focus mode on the status line: while keyboard focus is off the prompt (on the conversation's row cursor, on a view
 * of the bar, or in a search of the stream) one inverse chip names where it is, at the place the plan and yolo badges
 * take, so the reader never has to guess which keys are live. The prompt itself has no chip. The chip follows
 * `mayfly/focus-mode-changed`; the registration is the Fiber's and leaves with it.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-focus
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyFocusMode } from '../core/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'

/** The chip's words by mode (translated by the caller's catalog). */
const WORDS: Readonly<Record<Exclude<MayflyFocusMode, 'prompt'>, string>> = {
  conversation: 'conversation',
  bar: 'bar',
  search: 'search',
}

/**
 * The chip of a mode.
 * @param mode - where focus is.
 * @param t - translator for the chip's words.
 * @returns the status node, or `null` for the prompt.
 */
export function focusModeNode(mode: MayflyFocusMode, t: MayflyTranslate): MayflyStatusNode | null {
  if (mode === 'prompt') return null
  return ui.richText([{ text: ` ${t(WORDS[mode])} `, tone: 'primary', styles: ['strong', 'inverse'] }]) as MayflyStatusNode
}

/**
 * Mount the focus mode chip under the calling Fiber.
 * @param ctx - plugin context; needs `mayflyStatus`.
 * @param t - translator for the chip's words.
 */
export function mountFocusModeStatus(ctx: Context, t: MayflyTranslate): void {
  const registration = ctx.mayflyStatus.register({ id: 'mayfly.status.focus', priority: 1 }, null)
  ctx.effect(() => ctx.on('mayfly/focus-mode-changed', (mode) => { registration.set(focusModeNode(mode, t)) }))
  ctx.effect(() => () => registration.dispose())
}
