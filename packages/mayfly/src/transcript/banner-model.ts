/** Shared immutable banner content and renderer-owned layout primitives. @module */
import { flyInRows, markColumns, restRows, type MarkTextRun } from '../core/quad-mark.ts'
import type { MayflyColorFn, MayflySemanticColors } from '../core/types.ts'
import { MARK_BEAT, MARK_ROWS } from './banner-art.ts'
/** Below this content width the banner drops the mark and shows its four lines alone. */
export const BANNER_MIN_WIDTH = 40

/** Blank columns between the mark and the four lines. */
const MARK_GAP = 2

/** The slogan; brand identity stays English in every locale. */
export const SLOGAN = 'ephemeral agents, enduring works'

/**
 * Shorten a path by replacing the home-directory prefix with `~` — the exact
 * home and anything not under it (or an empty home) passes through.
 * @param path - the path to shorten.
 * @param home - the home directory, already normalized the same way.
 * @returns the shortened path.
 */
export function shortenHome(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

/** The banner's rendered facts. */
export interface BannerContent {
  /** The version beside the brand word. */
  readonly version: string
  /** The model id for the model line. */
  readonly model: string
  /** The provider route for the model line. */
  readonly provider: string
  /** The working directory, already home-shortened. */
  readonly cwd: string
}

/** The theme and measuring primitives `composeBannerLines` needs. */
export interface BannerDeps {
  /** The semantic color table. */
  readonly colors: MayflySemanticColors
  /** Renderer-owned strong emphasis. */
  readonly strong: (text: string) => string
  /** ANSI-aware truncation to a width, ending in `…` when it cuts. */
  readonly truncate: (text: string, width: number) => string
  /** ANSI-aware visible-width measurement. */
  readonly visibleWidth: (text: string) => number
  /** ASCII glyph mode: the mark is left out. */
  readonly ascii?: boolean
}

/** The version as shown beside the brand word: a release number reads `v0.1.3`, any other identity as it is. */
function versionLabel(version: string): string {
  return /^\d/u.test(version) ? `v${version}` : version
}

/** Styled runs cut to `max` columns; the run that does not fit ends in `…` and the rest are dropped. */
function fit(deps: BannerDeps, runs: readonly MarkTextRun[], max: number): MarkTextRun[] {
  const out: MarkTextRun[] = []
  let room = max
  for (const run of runs) {
    if (room <= 0) break
    // Tabs are one cell to visibleWidth but expand at the terminal; normalize before measuring and emitting.
    const text = run.text.replace(/\t/gu, '   ')
    const span = deps.visibleWidth(text)
    if (span <= room) {
      out.push(text === run.text ? run : { text, paint: run.paint })
      room -= span
      continue
    }
    out.push({ text: deps.truncate(text, room), paint: run.paint })
    room = 0
  }
  return out
}

/**
 * Compose the banner's lines for one width — the pure layout core the painter delegates to. Identity color functions
 * (the spec fakes) yield plain, measurable text.
 * @param deps - colors plus the truncate/measure primitives and the glyph mode.
 * @param content - the banner facts.
 * @param width - the content width in columns.
 * @param flyInAt - milliseconds into the fly-in, or undefined for the mark at rest.
 * @returns the four lines, the mark beside them when the width and glyph mode allow it.
 */
export function composeBannerLines(deps: BannerDeps, content: BannerContent, width: number, flyInAt?: number): string[] {
  if (width <= 0) return []
  const { colors } = deps
  const withMark = deps.ascii !== true && width >= BANNER_MIN_WIDTH
  const textWidth = withMark ? width - markColumns(MARK_ROWS) - MARK_GAP : width
  const brand: MayflyColorFn = text => deps.strong(colors.primary(text))
  const lines = [
    [{ text: 'mayfly', paint: brand }, { text: ` ${versionLabel(content.version)}`, paint: colors.textMuted }],
    [{ text: SLOGAN, paint: colors.accent }],
    [{ text: `${content.model} · ${content.provider}`, paint: colors.modelHighlight }],
    [{ text: content.cwd, paint: colors.muted }],
  ].map(runs => fit(deps, runs, textWidth))
  if (!withMark) return lines.map(runs => runs.map(run => run.paint(run.text)).join(''))
  const scene = { rows: MARK_ROWS, beat: MARK_BEAT, inks: colors.logoInks, gap: MARK_GAP, lines, width }
  return flyInAt === undefined ? restRows(scene) : flyInRows(scene, flyInAt)
}
