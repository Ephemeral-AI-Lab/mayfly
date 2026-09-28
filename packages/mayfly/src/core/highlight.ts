/**
 * Code-fence syntax coloring behind the pi-tui markdown `highlightCode`
 * hook (S10). Ported from kimi-code's `code-highlight.ts`: gate on
 * `supportsLanguage`, highlight with `ignoreIllegals`, and fall back to the
 * uncolored split on unknown languages or highlighter errors so the hook can
 * never change line count. The highlight theme keeps the palette as the only
 * color authority: `string`/`regexp`/`deletion` (cli-highlight's reds) are
 * reset to `base`, which itself is a Mayfly color fn and therefore re-resolved
 * on every `/theme` switch.
 */

import { highlight, supportsLanguage, type Theme } from 'cli-highlight'

import type { MayflyColorFn } from './types.ts'

/** Highlighted blocks kept for reuse across streaming frames. */
const HIGHLIGHT_CACHE_ENTRIES = 64

/* A streaming answer re-renders its whole Markdown on every delta, so every
   completed fence would re-highlight per frame. Results are memoized by the
   resolved base color (probed per call, so a `/theme` switch misses), the
   language, and the code; the oldest entry leaves first. */
const highlightCache = new Map<string, readonly string[]>()

/**
 * Split fenced code into syntax-highlighted lines.
 * @param code - the raw code block body.
 * @param lang - the info string after the fence, if any.
 * @param base - palette color used for plain runs and the de-reded tokens.
 * @returns one string per input line, never more or fewer.
 */
export function highlightCodeLines(code: string, lang: string | undefined, base: MayflyColorFn): string[] {
  const normalized = lang?.trim().toLowerCase()
  if (normalized === undefined || normalized === '' || !supportsLanguage(normalized)) return code.split('\n')
  const key = `${base(' ')}\u0000${normalized}\u0000${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) {
    highlightCache.delete(key)
    highlightCache.set(key, cached)
    return [...cached]
  }
  const theme: Theme = { default: base, string: base, regexp: base, deletion: base }
  let lines: string[]
  try {
    lines = highlight(code, { language: normalized, ignoreIllegals: true, theme }).split('\n')
  } catch {
    lines = code.split('\n')
  }
  highlightCache.set(key, lines)
  if (highlightCache.size > HIGHLIGHT_CACHE_ENTRIES) highlightCache.delete(highlightCache.keys().next().value!)
  return [...lines]
}
