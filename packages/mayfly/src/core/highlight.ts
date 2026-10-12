/**
 * Code-fence syntax coloring behind the pi-tui markdown `highlightCode`
 * hook (S10). Ported from kimi-code's `code-highlight.ts`: gate on
 * `supportsLanguage`, highlight with `ignoreIllegals`, and fall back to the
 * uncolored split on unknown languages or highlighter errors so the hook can
 * never change line count. The highlight theme keeps the palette as the only
 * color authority: keywords paint `primary` and strings `success` (the
 * design kit's two classes), comments `muted`, numbers and literals `number`,
 * types, classes, function and attribute names `type`, diff additions and
 * deletions their own paints, and every other token class the base color. Each
 * extra paint falls back to `base`, so monochrome and every theme hold.
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
  /** Numbers, literals (`true`, `null`), and symbols; the base color when absent. */
  readonly number?: MayflyColorFn
  /** Types, classes, built-ins, function titles, tag names, and attributes; the base color when absent. */
  readonly type?: MayflyColorFn
  /** The lines a diff block adds and removes; the base color when absent. */
  readonly added?: MayflyColorFn
  readonly removed?: MayflyColorFn
}

/** Token classes by the paint they take; every other class takes the base. */
const NUMBER_TOKENS = ['number', 'literal', 'symbol', 'bullet'] as const
const TYPE_TOKENS = ['type', 'class', 'title', 'function', 'built_in', 'builtin-name', 'name', 'tag', 'attr', 'attribute', 'section', 'selector-tag', 'selector-class', 'selector-id', 'template-tag'] as const
const KEYWORD_TOKENS = ['keyword', 'meta-keyword', 'doctag'] as const
const STRING_TOKENS = ['string', 'regexp', 'meta-string', 'subst', 'template-variable'] as const
const COMMENT_TOKENS = ['comment', 'meta', 'quote'] as const

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
  const paint = (tokens: readonly string[], color: MayflyColorFn | undefined): void => {
    if (color !== undefined) for (const token of tokens) theme[token] = perLine(color)
  }
  paint(KEYWORD_TOKENS, paints.keyword)
  paint(STRING_TOKENS, paints.string)
  paint(COMMENT_TOKENS, paints.comment)
  paint(NUMBER_TOKENS, paints.number)
  paint(TYPE_TOKENS, paints.type)
  paint(['addition'], paints.added)
  paint(['deletion'], paints.removed)
  return { ...theme, default: base }
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
  const key = `${[paints.base, paints.keyword, paints.string, paints.comment, paints.number, paints.type, paints.added, paints.removed].map(paint => paint?.(' ') ?? '').join('')}\u0000${normalized}\u0000${code}`
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
