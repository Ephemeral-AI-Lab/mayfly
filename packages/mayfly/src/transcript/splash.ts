/**
 * The launch screen's layout: the mark, the wordmark and slogan, and the recent
 * sessions of this directory, centered, from PR 22's sketch
 * (`docs/design/prototypes/splash-preview.mjs`). It paints into the transcript
 * prelude while no session exists and the `startup` setting asks for it; the
 * real editor and status row stay docked below, so the screen draws neither.
 * One column at every width, in tiers:
 *
 * - wide (at least {@link SPLASH_WIDE_WIDTH} columns and rows to spare): the mark at double size;
 * - medium (at least {@link SPLASH_ROW_PROJECT_WIDTH} list columns): the session rows carry their project;
 * - narrow (from {@link SPLASH_MIN_WIDTH}): title and age only;
 * - tiny (below it, or ASCII glyphs): the wordmark and slogan alone, with no mark and no list.
 *
 * Rows go before columns: a short screen drops the list, then the slogan, then
 * the mark, and the layout never exceeds the rows it is given. The layout is
 * pure: the caller measures and styles through {@link SplashDeps}.
 *
 * @module @ephemeral-ai/mayfly/transcript/splash
 */

import { FLY_IN_TOTAL_MS, markColumns, scaleRows, stageRows } from '../core/quad-mark.ts'
import type { MayflyColorFn, MayflySemanticColors } from '../core/types.ts'
import { MARK_BEAT, MARK_ROWS } from './banner-art.ts'

/** Below this width the splash is the wordmark and slogan alone. */
export const SPLASH_MIN_WIDTH = 40

/** From this content width (a 100-column terminal less its gutters and scrollbar), and with the rows for it, the mark is drawn at double size. */
export const SPLASH_WIDE_WIDTH = 96

/** From this list width a session row also shows its project. */
export const SPLASH_ROW_PROJECT_WIDTH = 56

/** The widest the session list grows; wider screens center it. */
export const SPLASH_LIST_MAX = 64

/** Sessions listed at most. */
export const SPLASH_RECENT_MAX = 4

/** The rows the double-size mark needs: the mark (8), the wordmark and slogan, and a full list. */
const WIDE_ROWS = 22

/** Columns of the age cell in a session row. */
const AGE_WIDTH = 9
/** Columns of the project cell, when shown. */
const PROJECT_WIDTH = 14

/** One recent session, already worded for the reader. */
export interface SplashSession {
  /** The stored session's id, which `Enter` resumes. */
  readonly id: string
  readonly title: string
  /** The project name (the directory's last segment). */
  readonly project: string
  /** The relative age, or `running`. */
  readonly age: string
  /** A live Agent runs it. */
  readonly live: boolean
}

/** The splash's words, translated by the caller. */
export interface SplashLabels {
  readonly slogan: string
  readonly recent: string
  /** The hint on the heading's right: how to reach the rest. */
  readonly more: string
  /** The same place while the list holds the keyboard: what its keys do. */
  readonly moreFocused: string
  readonly empty: string
  readonly emptyHint: string
}

/** The splash's rendered facts. */
export interface SplashContent {
  readonly version: string
  readonly labels: SplashLabels
  /** `undefined` until the catalog has been read: the list is left out rather than flashing "No sessions". */
  readonly recent: readonly SplashSession[] | undefined
  /** The row the list's cursor is on while `↑` browses it; `undefined` while the prompt holds the keyboard. */
  readonly focus?: number | undefined
}

/** The theme and measuring primitives the layout needs. */
export interface SplashDeps {
  readonly colors: MayflySemanticColors
  readonly strong: (text: string) => string
  readonly truncate: (text: string, width: number) => string
  readonly visibleWidth: (text: string) => number
  /** ASCII glyph mode: the mark and the status dot are left out. */
  readonly ascii?: boolean
}

const center = (deps: SplashDeps, text: string, width: number): string =>
  ' '.repeat(Math.max(0, Math.floor((width - deps.visibleWidth(text)) / 2))) + text

const pad = (deps: SplashDeps, text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - deps.visibleWidth(text)))

function versionLabel(version: string): string {
  return /^\d/u.test(version) ? `v${version}` : version
}

/** Left and right text on one row of `width` cells; when both do not fit, the right text is dropped. */
function split(deps: SplashDeps, left: string, right: string, width: number): string {
  const gap = width - deps.visibleWidth(left) - deps.visibleWidth(right)
  return gap < 2 ? deps.truncate(left, width) : left + ' '.repeat(gap) + right
}

/** One session row: pointer column, status dot, title, project when it fits, age. */
function sessionRow(deps: SplashDeps, session: SplashSession, width: number, selected: boolean): string {
  const { colors } = deps
  const withProject = width >= SPLASH_ROW_PROJECT_WIDTH
  const projectWidth = withProject ? PROJECT_WIDTH : 0
  const dot = deps.ascii === true ? (session.live ? '*' : '-') : (session.live ? '●' : '○')
  const titleWidth = Math.max(1, width - 4 - projectWidth - AGE_WIDTH)
  const text = deps.truncate(session.title, titleWidth)
  const title = pad(deps, selected ? deps.strong(colors.textStrong(text)) : colors.text(text), titleWidth)
  const project = withProject ? pad(deps, colors.textMuted(deps.truncate(session.project, projectWidth - 1)), projectWidth) : ''
  const age = ' '.repeat(Math.max(0, AGE_WIDTH - deps.visibleWidth(session.age))) + (session.live ? colors.success : colors.textMuted)(session.age)
  const marker = selected ? colors.accent(deps.ascii === true ? '>' : '›') : ' '
  const row = `${marker} ${(session.live ? colors.success : colors.textMuted)(dot)} ${title}${project}${age}`
  return selected ? colors.selectedBg(pad(deps, row, width)) : row
}

/** The list block: heading, rows (or the empty notice), and a blank row after it. */
function listBlock(deps: SplashDeps, content: SplashContent, width: number, rowsAvailable: number): string[] {
  const { colors } = deps
  const recent = content.recent
  if (recent === undefined) return []
  if (recent.length === 0) {
    const lines = [colors.muted(deps.truncate(content.labels.empty, width)), colors.textMuted(deps.truncate(content.labels.emptyHint, width))]
    return lines.slice(0, Math.max(0, rowsAvailable))
  }
  const focused = content.focus !== undefined
  const heading = split(deps, colors.muted(content.labels.recent), colors.textMuted(focused ? content.labels.moreFocused : content.labels.more), width)
  const room = Math.min(recent.length, SPLASH_RECENT_MAX, rowsAvailable - 1)
  if (room <= 0) return []
  return [heading, ...recent.slice(0, room).map((session, index) => sessionRow(deps, session, width, content.focus === index))]
}

/**
 * Compose the launch screen's rows for one size.
 * @param deps - colors plus the measure/truncate primitives and the glyph mode.
 * @param content - the splash facts.
 * @param width - the content width in columns.
 * @param rows - the rows the screen has above the editor; the result is never taller.
 * @param flyInAt - milliseconds into the fly-in, or undefined for the mark at rest.
 * @returns the rows, centered vertically in `rows` and horizontally in `width`.
 */
export function composeSplashLines(deps: SplashDeps, content: SplashContent, width: number, rows: number, flyInAt?: number): string[] {
  if (width <= 0 || rows <= 0) return []
  const { colors } = deps
  const brand: MayflyColorFn = text => deps.strong(colors.primary(text))
  const wordmark = center(deps, `${brand('mayfly')} ${colors.textMuted(versionLabel(content.version))}`, width)
  const slogan = center(deps, colors.accent(deps.truncate(content.labels.slogan, width)), width)
  const listWidth = Math.min(width - 4, SPLASH_LIST_MAX)
  const withMark = deps.ascii !== true && width >= SPLASH_MIN_WIDTH
  const withList = width >= SPLASH_MIN_WIDTH && listWidth >= 20

  // Draw the richest tier that fits the rows, then drop pieces bottom-first.
  const scale = withMark && width >= SPLASH_WIDE_WIDTH && rows >= WIDE_ROWS ? 2 : 1
  const markRows = scale === 2 ? scaleRows(MARK_ROWS, 2) : [...MARK_ROWS]
  const markBeat = scale === 2 ? scaleRows(MARK_BEAT, 2) : [...MARK_BEAT]
  const stage = withMark
    ? stageRows({ rows: markRows, beat: markBeat, inks: colors.logoInks, width, left: Math.max(0, Math.floor((width - markColumns(markRows)) / 2)) }, flyInAt)
    : []
  // The wordmark and slogan appear once the mark is most of the way in.
  const shown = flyInAt === undefined || flyInAt >= FLY_IN_TOTAL_MS * 0.55
  const brandRows = shown ? [wordmark, slogan] : ['', '']

  const lead = ' '.repeat(Math.max(0, Math.floor((width - listWidth) / 2)))
  const body: string[] = []
  const budget = Math.max(1, rows)
  const header = [...stage, ...(stage.length === 0 ? [] : ['']), ...brandRows]
  const room = budget - header.length - 1
  const list = withList ? listBlock(deps, content, listWidth, room) : []
  body.push(...header)
  if (list.length > 0) body.push('', ...list.map(line => lead + line))

  let out = body
  // Too tall: the list went first above; now the slogan, then the mark.
  if (out.length > budget) out = [...stage, ...(stage.length === 0 ? [] : ['']), brandRows[0]!]
  if (out.length > budget) out = [brandRows[0]!]
  const top = Math.max(0, Math.floor((budget - out.length) / 2))
  return [...Array.from({ length: top }, () => ''), ...out]
}
