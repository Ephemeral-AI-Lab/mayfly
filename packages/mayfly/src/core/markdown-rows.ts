/**
 * Block segmentation and fragment painting for the windowed `markdown` leaf (`content-rows.ts`). One pass over the
 * source emits paint units — groups of top-level lexer tokens, closed Mermaid fences (split exactly where
 * `splitRichDocument` splits them, with their source-fence fallback), and oversized single tokens deferred to
 * raw-line painting — so a windowed source renders only the blocks under the viewport while producing the same
 * rows the eager segment renderer produces.
 *
 * The lexer decides the boundaries: a unit is a run of marked tokens (`marked` 18.0.5, pi-tui's own version, with
 * pi-tui's block `$$`/`\\[` extension mirrored so the token stream matches the renderer's) that ends just before
 * the next `space` token or just after one. pi-tui suppresses a construct's trailing blank only when a `space`
 * token follows, so cutting anywhere else would either drop or invent a spacing row — next to a space token the
 * fragment's own parse produces the same rows the whole render produces. A single token can never be cut, so
 * oversized ones (`lines`) fall back to raw-line segments and a run of adjacent tokens past budget stays whole.
 * Link-reference definitions resolve document-wide in marked's `links`, so every raw def line (top-level or nested
 * inside a quote or list, exactly the tags marked accepted) joins a preamble prepended to bracketed fragments;
 * def lines inside a paragraph are literal text there and never reach `links`, so they are never collected.
 *
 * @module @ephemeral-ai/mayfly/core/markdown-rows
 */

import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui'
import { Marked, type Token, type TokenizerAndRendererExtension } from 'marked'
import { CONTENT_SEGMENT_UNITS } from './content-segments.ts'
import { highlightCodeLines } from './highlight.ts'
import { renderMermaidRows, splitRichDocument } from './rich-document.ts'
import type { MayflySemanticColors } from './types.ts'

/**
 * Map the palette to a markdown theme: the ten md* tokens plus emphasis.
 * Headings carry their level through bold (0.84.2 exposes a single
 * `heading` fn, so kimi's per-level styling is out of reach), unordered
 * markers are normalized to `•`, and fenced code goes through cli-highlight
 * via `highlightCode`, which recolors lines without changing their count.
 */
export function markdownTheme(colors: MayflySemanticColors): MarkdownTheme {
  return {
    heading: (text) => `\x1b[1m${colors.mdHeading(text)}\x1b[22m`,
    link: colors.mdLink,
    linkUrl: colors.mdLinkUrl,
    code: colors.mdCode,
    codeBlock: colors.mdCodeBlock,
    codeBlockBorder: colors.mdCodeBlockBorder,
    quote: colors.mdQuote,
    quoteBorder: colors.mdQuoteBorder,
    hr: colors.mdHr,
    listBullet: (marker) => colors.mdListBullet(marker.replace(/^[-+*] $/, '• ')),
    bold: colors.textStrong,
    italic: colors.text,
    strikethrough: colors.muted,
    underline: colors.text,
    highlightCode: (code, lang) => highlightCodeLines(code, lang, { base: colors.mdCodeBlock, keyword: colors.primary, string: colors.success, comment: colors.muted }),
  }
}

/**
 * Re-paint pi-tui's width-capped horizontal rules to the full render width.
 * pi-tui caps them at 80 columns regardless of the render width
 * (`'─'.repeat(Math.min(width, 80))` in markdown.js); the user's S17 dogfood
 * ruling wants the rule as wide as the body text it separates. Exact string
 * equality against the known theme output — tolerating pi-tui's row padding —
 * keeps code lines (their own SGRs) and any custom rule styling out of the path.
 */
export function expandMarkdownRules(lines: string[], width: number, hr: (text: string) => string): string[] {
  if (width <= 80) return lines
  const capped = hr('─'.repeat(80))
  const full = hr('─'.repeat(width))
  return lines.map(line => line.trimEnd() === capped ? full : line)
}

/** Raw budget of one paint unit, matching the content segmenter's unit so a fragment paint costs a segment paint. */
const MARKDOWN_UNIT_UNITS = CONTENT_SEGMENT_UNITS

/**
 * One paint unit of a scanned Markdown document. `block` is a run of lexer tokens (blank runs included) sliced
 * from `normalized` and painted on demand, `lines` a single token too large for a fragment — painted as raw
 * source lines — and `mermaid` a closed fence (diagram or its source-fence fallback). `start`/`end` are offsets
 * into `PreparedMarkdown.normalized`, `estimate` the row guess the live count starts from.
 */
export type MarkdownUnit =
  | { readonly kind: 'block', readonly start: number, readonly end: number, readonly estimate: number, readonly flow: number }
  | { readonly kind: 'lines', readonly start: number, readonly end: number, readonly estimate: number, readonly flow: number }
  | { readonly kind: 'mermaid', readonly source: string, readonly fallback: string, readonly start: number, readonly estimate: number }

/** One link-reference definition the document resolves: its tag and its complete raw text. */
export interface MarkdownDef {
  readonly tag: string
  readonly raw: string
}

/** The scanned shape of one Markdown source, computed once per admitted node. */
export interface PreparedMarkdown {
  /** The source after the same normalization marked and pi-tui apply (`\r\n?` → `\n`, `\t` → 3 spaces). */
  readonly normalized: string
  readonly units: readonly MarkdownUnit[]
  /**
   * Every raw link-reference definition marked collected into `links`, first occurrence per tag. A fragment gets
   * back exactly the tags it cannot already resolve — injecting a tag the fragment defines would swallow its own
   * def line as a marked duplicate and change the spacing a neighbor token sees.
   */
  readonly defs: readonly MarkdownDef[]
  /** Source line count, for the caller's work counter. */
  readonly lines: number
}

/** pi-tui 0.84.2 markdown.js: the heuristic a pending `$$`/`\\[` block must satisfy to keep reading. */
function looksLikePendingDollarMath(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source)
}

/** pi-tui 0.84.2 markdown.js: block-level `$$…$$` / `\[…\]` tokens, pending forms swallowing to end of input. */
function tokenizeBlockLatex(source: string): Record<string, unknown> | undefined {
  const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source)
  if (dollarMatch?.[1]) return { type: 'latexBlock', raw: dollarMatch[0], text: dollarMatch[1].trim() }
  const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source)
  if (bracketMatch?.[1]) return { type: 'latexBlock', raw: bracketMatch[0], text: bracketMatch[1].trim() }
  const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source)
  if (pendingBracket) return { type: 'latexBlock', raw: pendingBracket[0], text: pendingBracket[1], pending: true }
  const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source)
  if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
    return { type: 'latexBlock', raw: pendingDollar[0], text: pendingDollar[1], pending: true }
  }
  return undefined
}

/**
 * The scan lexer — `marked` 18.0.5 with pi-tui 0.84.2's `latexBlock` extension mirrored so unit boundaries follow
 * the same token stream the renderer walks (the inline `latex` extension and the strict `del` tokenizer cannot
 * change where block tokens end, so they are not needed here).
 */
const scanParser = new Marked()
const latexBlockExtension: TokenizerAndRendererExtension = {
  name: 'latexBlock',
  level: 'block',
  start(source: string) {
    const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)
    return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined
  },
  tokenizer(source: string) { return tokenizeBlockLatex(source) as Token | undefined },
}
scanParser.use({ extensions: [latexBlockExtension] })

/** Every `def` token's raw text, in tree order, for the tags marked actually resolved into `links`. */
function collectDefs(tokens: readonly Token[], links: Readonly<Record<string, unknown>>, into: MarkdownDef[], seen: Set<string>): void {
  for (const token of tokens) {
    const typed = token as Token & { readonly tag?: string, readonly tokens?: Token[], readonly items?: { readonly tokens?: Token[] }[] }
    if (typed.type === 'def' && typed.tag !== undefined && typed.tag in links && !seen.has(typed.tag)) {
      seen.add(typed.tag)
      into.push({ tag: typed.tag, raw: typed.raw.endsWith('\n') ? typed.raw : `${typed.raw}\n` })
    }
    if (typed.tokens !== undefined) collectDefs(typed.tokens, links, into, seen)
    if (typed.items !== undefined) for (const item of typed.items) {
      if (item.tokens !== undefined) collectDefs(item.tokens, links, into, seen)
    }
  }
}

/**
 * Scan `source` into paint units and the reference-definition preamble, in one pass. Mermaid fences split wherever
 * `splitRichDocument` finds them, and inside each Markdown segment marked's own token stream decides where a
 * fragment may end — only ever adjacent to a `space` token — so a fragment render is indistinguishable from the
 * same token span inside the whole render.
 */
export function scanMarkdown(source: string): PreparedMarkdown {
  const normalized = source.replace(/\r\n?/gu, '\n').replace(/\t/gu, '   ')
  const units: MarkdownUnit[] = []
  const defs: MarkdownDef[] = []
  const seenDefs = new Set<string>()
  let cursor = 0

  for (const segment of splitRichDocument(normalized)) {
    const segmentRaw = segment.kind === 'mermaid' ? segment.fallback : segment.source
    const segmentStart = normalized.indexOf(segmentRaw, cursor)
    if (segment.kind === 'mermaid') {
      units.push({ kind: 'mermaid', source: segment.source, fallback: segment.fallback, start: Math.max(0, segmentStart), estimate: segment.source.split('\n').length + 2 })
      cursor = segmentStart + segmentRaw.length
      continue
    }
    const tokens = scanParser.lexer(segmentRaw) as Token[] & { readonly links?: Record<string, unknown> }
    if (tokens.links !== undefined) collectDefs(tokens, tokens.links, defs, seenDefs)
    let start = -1
    let end = -1
    let estimate = 0
    let flow = 0
    let lastIsSpace = true
    let position = segmentStart < 0 ? cursor : segmentStart
    const flush = (): void => {
      if (start < 0) return
      units.push({ kind: 'block', start, end, estimate, flow })
      start = -1
      estimate = 0
      flow = 0
    }
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!
      const at = normalized.startsWith(token.raw, position) ? position : normalized.indexOf(token.raw, position)
      if (at < 0) {
        // A raw the scan cannot place (marked never emits one, but a parse anomaly must not lose content):
        // the rest of the segment joins one fragment, still painted through the real renderer.
        units.push({ kind: 'block', start: Math.max(start, position), end: segmentStart + segmentRaw.length, estimate, flow })
        start = -1
        break
      }
      const isSpace = token.type === 'space'
      if (!isSpace && token.raw.length > MARKDOWN_UNIT_UNITS && (start < 0 || lastIsSpace)) {
        flush()
        units.push({ kind: 'lines', start: at, end: at + token.raw.length, estimate: token.raw.split('\n').length, flow: token.raw.length })
        position = at + token.raw.length
        lastIsSpace = false
        continue
      }
      if (start >= 0 && lastIsSpace && !isSpace && end - start + token.raw.length > MARKDOWN_UNIT_UNITS) flush()
      if (start < 0) start = at
      end = at + token.raw.length
      // Estimate the token's painted rows: a space is one blank row, a def paints none, and every other
      // construct paints its source lines plus the trailing blank pi-tui adds when a non-space token follows.
      // `flow` sums paintable characters so the width-aware source can lift the floor for wrapping prose.
      const next = tokens[index + 1]
      estimate += isSpace ? 1 : token.type === 'def' ? 0 : token.raw.split('\n').length + (next !== undefined && next.type !== 'space' ? 1 : 0)
      if (!isSpace) flow += token.raw.length
      lastIsSpace = isSpace
      position = end
    }
    flush()
    cursor = segmentStart < 0 ? position : segmentStart + segmentRaw.length
  }
  return { normalized, units, defs, lines: normalized.split('\n').length }
}

/**
 * A fragment's Markdown render at `width`: the defs the fragment cannot already resolve restored as a prologue.
 * Injecting a tag the fragment defines itself would let marked swallow its line as a duplicate def — no token —
 * and flip a neighbor's `nextTokenType`, so the prologue keeps only tags absent from the fragment's own `links`.
 */
export function markdownBlockRows(text: string, defs: readonly MarkdownDef[], width: number, theme: MarkdownTheme, hr: (text: string) => string): string[] {
  let fragment = text
  if (defs.length > 0 && text.includes('[')) {
    const local = (scanParser.lexer(text) as Token[] & { readonly links?: Record<string, unknown> }).links ?? {}
    const prologue = defs.filter(def => !(def.tag in local)).map(def => def.raw).join('')
    if (prologue !== '') fragment = prologue + text
  }
  return expandMarkdownRules(new Markdown(fragment, 0, 0, theme).render(width), width, hr)
}

/**
 * A Mermaid unit's rows: the ASCII diagram when the bounded renderer accepts the source, else the source-fence
 * fallback as a fragment — or undefined when the fallback is itself oversized and the caller paints it raw.
 */
export function markdownMermaidRows(source: string, fallback: string, width: number, theme: MarkdownTheme, hr: (text: string) => string): string[] | undefined {
  const diagram = renderMermaidRows(source, width)
  if (diagram !== undefined) return diagram
  if (fallback.length > CONTENT_SEGMENT_UNITS) return undefined
  return expandMarkdownRules(new Markdown(fallback, 0, 0, theme).render(width), width, hr)
}
