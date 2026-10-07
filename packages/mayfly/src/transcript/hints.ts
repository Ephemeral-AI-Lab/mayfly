/**
 * Localized fold hints shared by transcript cards. A hint names Ctrl-O only
 * when the toggle reaches the card's turn; older turns state what is hidden
 * without promising a key that cannot open it.
 *
 * @module @ephemeral-ai/mayfly/transcript/hints
 */

import type { MayflyTranslate } from '../frontend/index.ts'

/**
 * The hidden-lines hint of one folded body.
 * @param t - transcript translator.
 * @param remaining - wrapped rows hidden by the fold.
 * @param total - total wrapped rows, when known.
 * @param keyed - whether Ctrl-O reaches this card.
 * @returns the hint text.
 */
export function moreLinesHint(t: MayflyTranslate, remaining: number, total: number | undefined, keyed: boolean): string {
  const one = remaining === 1
  if (total === undefined) {
    if (keyed) return t(one ? '... (1 more line, Ctrl+O to expand)' : '... ({remaining} more lines, Ctrl+O to expand)', { remaining })
    return t(one ? '... (1 more line)' : '... ({remaining} more lines)', { remaining })
  }
  if (keyed) return t(one ? '... (1 more line, {total} total, Ctrl+O to expand)' : '... ({remaining} more lines, {total} total, Ctrl+O to expand)', { remaining, total })
  return t(one ? '... (1 more line, {total} total)' : '... ({remaining} more lines, {total} total)', { remaining, total })
}

/**
 * The hint of a body whose length is unknown (a scan-capped preview).
 * @param t - transcript translator.
 * @param keyed - whether Ctrl-O reaches this card.
 * @returns the hint text.
 */
export function moreOutputHint(t: MayflyTranslate, keyed: boolean): string {
  return t(keyed ? '... (more output, Ctrl+O to expand)' : '... (more output)')
}

/**
 * The hidden-rows hint of a folded tree card.
 * @param t - transcript translator.
 * @param count - tree rows hidden by the fold.
 * @param keyed - whether Ctrl-O reaches this card.
 * @returns the hint text.
 */
export function moreRowsHint(t: MayflyTranslate, count: number, keyed: boolean): string {
  return t(keyed ? '... ({count} more, Ctrl+O to expand)' : '... ({count} more)', { count })
}

/** Chinese copy for every hint key above. */
export const HINTS_ZH: Readonly<Record<string, string>> = {
  '... (1 more line, Ctrl+O to expand)': '...（还有 1 行，按 Ctrl+O 展开）',
  '... ({remaining} more lines, Ctrl+O to expand)': '...（还有 {remaining} 行，按 Ctrl+O 展开）',
  '... (1 more line)': '...（还有 1 行）',
  '... ({remaining} more lines)': '...（还有 {remaining} 行）',
  '... (1 more line, {total} total, Ctrl+O to expand)': '...（还有 1 行，共 {total} 行，按 Ctrl+O 展开）',
  '... ({remaining} more lines, {total} total, Ctrl+O to expand)': '...（还有 {remaining} 行，共 {total} 行，按 Ctrl+O 展开）',
  '... (1 more line, {total} total)': '...（还有 1 行，共 {total} 行）',
  '... ({remaining} more lines, {total} total)': '...（还有 {remaining} 行，共 {total} 行）',
  '... (more output, Ctrl+O to expand)': '...（还有更多输出，按 Ctrl+O 展开）',
  '... (more output)': '...（还有更多输出）',
  '... ({count} more, Ctrl+O to expand)': '...（还有 {count} 项，按 Ctrl+O 展开）',
  '... ({count} more)': '...（还有 {count} 项）',
}
