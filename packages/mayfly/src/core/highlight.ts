/**
 * Code-fence syntax coloring behind the pi-tui markdown `highlightCode`
 * hook (S10). Ported from kimi-code's `code-highlight.ts`: gate on
 * `supportsLanguage`, highlight with `ignoreIllegals`, and fall back to the
 * uncolored split on unknown languages or highlighter errors so the hook can
 * never change line count. The highlight theme keeps the palette as the only
 * color authority: keywords paint `primary` and strings `success` (the
 * design kit's two classes), comments `muted`, and every other token class
 * the base color, so monochrome and every theme hold.
 *
 * @module @ephemeral-ai/mayfly/core/highlight
 */

import { DEFAULT_THEME, highlight, supportsLanguage, type Theme } from 'cli-highlight'

import type { MayflyColorFn } from './types.ts'

/** Highlighted blocks kept for reuse across streaming frames. */
const HIGHLIGHT_CACHE_ENTRIES = 64

/** The palette paints a highlighted block uses: the kit's keywords and strings, comments, and everything else. */
export interface CodePaints {
  /** Plain runs and every token class without its own paint. */
  readonly base: MayflyColorFn
  readonly keyword: MayflyColorFn
  readonly string: MayflyColorFn
  readonly comment: MayflyColorFn
}

/* A streaming answer re-renders its whole Markdown on every delta, so every
   completed fence would re-highlight per frame. Results are memoized by the
   resolved paints (probed per call, so a `/theme` switch misses), the
   language, and the code; the oldest entry leaves first. */
const highlightCache = new Map<string, readonly string[]>()

/** A paint that closes on every line, so splitting the highlighted block never leaves a run open across rows. */
function perLine(paint: MayflyColorFn): MayflyColorFn {
  return text => text.split('\n').map(line => line === '' ? '' : paint(line)).join('\n')
}

/** Every token class cli-highlight knows paints `base`, so no color outside the palette reaches the terminal. */
function paletteTheme(paints: CodePaints): Theme {
  const base = perLine(paints.base)
  const theme: Record<string, MayflyColorFn> = Object.fromEntries(Object.keys(DEFAULT_THEME).map(token => [token, base]))
  return { ...theme, default: base, keyword: perLine(paints.keyword), string: perLine(paints.string), comment: perLine(paints.comment) }
}

/**
 * Whether a language name has a highlighter.
 * @param lang - the language name, if any.
 * @returns true when {@link highlightCodeLines} would color it.
 */
export function highlightable(lang: string | undefined): lang is string {
  const normalized = lang?.trim().toLowerCase()
  return normalized !== undefined && normalized !== '' && supportsLanguage(normalized)
}

/**
 * Split fenced code into syntax-highlighted lines.
 * @param code - the raw code block body.
 * @param lang - the info string after the fence, if any.
 * @param paints - the palette paints; keywords and strings take the kit's tones.
 * @returns one string per input line, never more or fewer.
 */
export function highlightCodeLines(code: string, lang: string | undefined, paints: CodePaints): string[] {
  const normalized = lang?.trim().toLowerCase()
  if (!highlightable(normalized)) return code.split('\n')
  const key = `${paints.base(' ')}${paints.keyword(' ')}${paints.string(' ')}${paints.comment(' ')}\u0000${normalized}\u0000${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) {
    highlightCache.delete(key)
    highlightCache.set(key, cached)
    return [...cached]
  }
  let lines: string[]
  try {
    lines = highlight(code, { language: normalized, ignoreIllegals: true, theme: paletteTheme(paints) }).split('\n')
  } catch {
    lines = code.split('\n')
  }
  highlightCache.set(key, lines)
  if (highlightCache.size > HIGHLIGHT_CACHE_ENTRIES) highlightCache.delete(highlightCache.keys().next().value!)
  return [...lines]
}
