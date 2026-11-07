import { ui, type MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyFocusMode } from '../core/types.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'

/** The chip's words by mode (translated by the caller's catalog). */
const WORDS: Readonly<Record<Exclude<MayflyFocusMode, 'prompt'>, string>> = {
  conversation: 'conversation',
  view: 'view',
  search: 'search',
  'search-select': 'search',
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

