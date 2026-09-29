/** Core-owned keyboard routing for the transcript's semantic disclosure cursor.
 * @module @ephemeral-ai/mayfly/core/transcript-focus
 */
import type { MayflyTranslate } from '../frontend/locale.ts'
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import type { MayflyComponents, MayflySemanticColors, MayflyComponent, MayflyFocusable, MayflyKeymap, MayflyScreen } from './types.ts'
import { ACTION_CANCEL, ACTION_MOVE_UP, ACTION_MOVE_DOWN, ACTION_HOME, ACTION_END, ACTION_SUBMIT, ACTION_PAGE_UP, ACTION_PAGE_DOWN, matchesKeyAction, displayKey } from './key-actions.ts'

export type TranscriptNavigation = 'previous' | 'next' | 'first' | 'last' | 'toggle'
export function transcriptFocus(content: MayflyComponent, keys: MayflyKeymap, screen: MayflyScreen, change: (intent: TranscriptNavigation | boolean) => number | undefined, available: () => boolean): MayflyFocusable {
  let focused = false
  return {
    get canFocus() { return available() },
    get focused() { return focused },
    set focused(value) { focused = value; change(value); screen.requestRender() },
    render: width => content.render(width),
    invalidate: () => content.invalidate(),
    handleInput(data) {
      if (matchesKeyAction(keys, data, ACTION_CANCEL)) { screen.focusPrompt?.(); return }
      if (matchesKeyAction(keys, data, ACTION_PAGE_UP) || matchesKeyAction(keys, data, ACTION_PAGE_DOWN)) {
        screen.scrollContent(matchesKeyAction(keys, data, ACTION_PAGE_UP) ? 'up' : 'down', Math.max(1, screen.rows - 4))
        return
      }
      const intent = matchesKeyAction(keys, data, ACTION_MOVE_UP) ? 'previous'
        : matchesKeyAction(keys, data, ACTION_MOVE_DOWN) ? 'next'
          : matchesKeyAction(keys, data, ACTION_HOME) ? 'first'
            : matchesKeyAction(keys, data, ACTION_END) ? 'last'
              : matchesKeyAction(keys, data, ACTION_SUBMIT) ? 'toggle' : undefined
      if (intent === undefined) return
      const row = change(intent)
      if (row !== undefined) screen.revealTranscriptRow?.(row)
      screen.requestRender()
    },
  }
}

/** The selected turn advertises the same bindings the focus wrapper dispatches. */
export function transcriptNavigationHint(keys: MayflyKeymap, expanded: boolean, t: MayflyTranslate): string {
  const key = (actions: readonly string[]) => actions.flatMap(action => keys.getKeys(action)).map(displayKey).join('/')
  return [
    [key([ACTION_MOVE_UP, ACTION_MOVE_DOWN]), t('turns')],
    [key([ACTION_SUBMIT]), expanded ? t('collapse') : t('expand')],
    [key([ACTION_CANCEL]), t('leave')],
  ].filter(([binding]) => binding !== '').map(([binding, label]) => `${binding} ${label}`).join(' · ')
}

/** Paint the semantic cursor without exposing terminal markers to feature code. */
export function markTranscriptCursor(rows: string[], width: number, hint: string | undefined, components: MayflyComponents, colors: MayflySemanticColors): string[] {
  const first = rows.findIndex(row => row.trim() !== '')
  if (first < 0) return rows
  const result = [...rows]
  const pointer = components.asciiGlyphs === true ? '>' : '→'
  result[first] = CURSOR_MARKER + components.truncateToWidth(`${pointer} ${rows[first]}`, width)
  if (hint !== undefined) result.splice(first + 1, 0, components.truncateToWidth(colors.textMuted(hint), width))
  return result
}

/** Return the painted cursor row for core's viewport reveal operation. */
export function transcriptCursorRow(rows: readonly string[]): number { return rows.findIndex(row => row.includes(CURSOR_MARKER)) }
