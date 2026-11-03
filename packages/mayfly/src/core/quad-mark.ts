/**
 * Pixel marks drawn in quadrant blocks (`▘▝▀▖▌▞▛▗▚▐▜▄▙▟█`), where each cell holds 2×2 pixels, and the one-shot fly-in
 * that brings a mark into its slot beside a few lines of text. Ported from PR 22's sketches
 * (`docs/design/prototypes/logo-preview.mjs`, `fly-in.mjs`): the mark enters from the right edge beating its wings,
 * eases into its slot behind a short trail of fading pixels, beats twice and rests, and each line of text shows only
 * where the mark has already passed. A frame is a pure function of the time since the start, so any moment renders on
 * its own and a frozen clock gives a stable frame.
 *
 * Pixel rows use one key per pixel: `B` and `T` for the body and its antennae and tails, `W` for the wings, `a`, `b`,
 * `c` for the trail from the nearest pixel to the farthest, `.` for none. Inks come in that order: body, wings, trail.
 * Core owns this because it measures graphemes and composes cells.
 *
 * @module @ephemeral-ai/mayfly/core/quad-mark
 */

import type { MayflyColorFn } from './types.ts'
import { visibleWidth } from './width.ts'

/** The quadrant glyph of each 4-bit mask: upper-left 1, upper-right 2, lower-left 4, lower-right 8. */
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

/** The ink each pixel key paints with, as an index into the inks. */
const INK_INDEX: Readonly<Record<string, number>> = { B: 0, T: 0, W: 1, a: 2, b: 3, c: 4 }

/** How long the mark flies before it lands, in milliseconds. */
export const FLY_IN_FLIGHT_MS = 1100

/** The whole fly-in, landing and the two slow wing beats included, in milliseconds. */
export const FLY_IN_TOTAL_MS = 1550

/** The repaint interval while the fly-in plays (about 30 frames a second). */
export const FLY_IN_FRAME_MS = 33

/** One styled run of text beside the mark. */
export interface MarkTextRun {
  readonly text: string
  readonly paint: MayflyColorFn
}

/** A mark and the text beside it. */
export interface MarkScene {
  /** The mark's pixels at rest; every row is as long as the first, and the row count is even. */
  readonly rows: readonly string[]
  /** The mark's pixels with the wings up, the beat's second frame. */
  readonly beat: readonly string[]
  /** The inks, by the order of the pixel keys: body, wings, trail near, trail mid, trail far. */
  readonly inks: readonly MayflyColorFn[]
  /** Blank columns between the mark and the text. */
  readonly gap: number
  /** One line of text per cell row, already fitted to the columns right of the mark and the gap. */
  readonly lines: readonly (readonly MarkTextRun[])[]
  /** The viewport width in columns. */
  readonly width: number
}

/**
 * The beat's second frame: every wing pixel one row higher.
 * @param rows - the mark's pixels at rest.
 * @returns the pixels with the wings up.
 */
export function liftWings(rows: readonly string[]): string[] {
  return rows.map((row, y) => [...row].map((key, x) => {
    const below = rows[y + 1]?.[x]
    if (below === 'W') return below
    return key === 'W' ? '.' : key
  }).join(''))
}

/** The columns a mark occupies. */
export function markColumns(rows: readonly string[]): number {
  return Math.ceil((rows[0]?.length ?? 0) / 2)
}

/** A cell of a composed row: a glyph and its paint, or blank. */
interface Cell {
  readonly glyph: string
  readonly paint?: MayflyColorFn
  /** Set on the right half of a wide grapheme, which the left half draws. */
  readonly continuation?: true
}

const BLANK: Cell = { glyph: ' ' }

/** Pixels drawn on a canvas, keyed `x,y`. */
type Canvas = Map<string, string>

/** Draw pixel rows onto a canvas with the upper-left pixel at `(x0, y0)`. */
function stamp(canvas: Canvas, rows: readonly string[], x0: number, y0: number): void {
  rows.forEach((row, y) => {
    [...row].forEach((key, x) => { if (key !== '.') canvas.set(`${x0 + x},${y0 + y}`, key) })
  })
}

/**
 * One cell from a canvas: the ink covering most of its four pixels (the nearer ink on a tie) in that ink's quadrants.
 * Marks keep two inks out of one cell, so a cell never needs a background.
 */
function quadCell(canvas: Canvas, inks: readonly MayflyColorFn[], cx: number, cy: number): Cell | undefined {
  const indexes = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => {
    const key = canvas.get(`${2 * cx + dx!},${2 * cy + dy!}`)
    return key === undefined ? undefined : INK_INDEX[key]
  })
  let best: number | undefined
  let bestCount = 0
  for (const index of new Set(indexes)) {
    if (index === undefined) continue
    const count = indexes.filter(value => value === index).length
    if (count > bestCount || (count === bestCount && index < best!)) { best = index; bestCount = count }
  }
  if (best === undefined) return undefined
  const mask = indexes.reduce<number>((bits, index, bit) => (index === best ? bits | (1 << bit) : bits), 0)
  const paint = inks[best]
  return paint === undefined ? { glyph: QUAD[mask]! } : { glyph: QUAD[mask]!, paint }
}

/** The cells of one line of text, starting at `column`, cut at `width`. */
function textCells(cells: Cell[], runs: readonly MarkTextRun[], column: number, width: number): void {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let at = column
  for (const run of runs) {
    for (const { segment } of segmenter.segment(run.text)) {
      const span = visibleWidth(segment)
      if (span === 0) {
        const last = cells[at - 1]
        if (last !== undefined && at > column) cells[at - 1] = { ...last, glyph: last.glyph + segment }
        continue
      }
      if (at + span > width) return
      cells[at] = { glyph: segment, paint: run.paint }
      for (let k = 1; k < span; k += 1) cells[at + k] = { glyph: '', continuation: true }
      at += span
    }
  }
}

/** Join cells into a row, one paint call per run of cells that share a paint, trailing blanks dropped. */
function joinCells(cells: readonly Cell[]): string {
  let end = cells.length
  while (end > 0 && cells[end - 1]!.glyph === ' ' && cells[end - 1]!.paint === undefined) end -= 1
  let out = ''
  let run = ''
  let paint: MayflyColorFn | undefined
  const flush = (): void => {
    if (run !== '') out += paint === undefined ? run : paint(run)
    run = ''
  }
  for (const cell of cells.slice(0, end)) {
    if (cell.paint !== paint) { flush(); paint = cell.paint }
    run += cell.glyph
  }
  flush()
  return out
}

/**
 * Blank the halves of a wide grapheme that lost their other half (to the mark, the trail, or the hidden side of the
 * wake), so no row ever paints a grapheme wider than its cells.
 */
function repairWide(cells: Cell[]): void {
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i]!
    if (cell.continuation === true) {
      const head = cells[i - 1]
      if (head === undefined || head.continuation === true || visibleWidth(head.glyph) < 2) cells[i] = BLANK
      continue
    }
    if (visibleWidth(cell.glyph) >= 2 && cells[i + 1]?.continuation !== true) cells[i] = BLANK
  }
}

/** The rows of the scene with the mark at rest: the mark, the gap, the text. */
export function restRows(scene: MarkScene): string[] {
  const canvas: Canvas = new Map()
  stamp(canvas, scene.rows, 0, 0)
  return composeRows(scene, canvas, new Map(), 0)
}

/** Compose every cell row from the mark's canvas, the trail, and the text, hiding text left of `wake`. */
function composeRows(scene: MarkScene, canvas: Canvas, under: Canvas, wake: number): string[] {
  const cellRows = Math.max(Math.ceil(scene.rows.length / 2), scene.lines.length)
  const column = markColumns(scene.rows) + scene.gap
  const rows: string[] = []
  for (let cy = 0; cy < cellRows; cy += 1) {
    const cells: Cell[] = Array.from({ length: scene.width }, () => BLANK)
    textCells(cells, scene.lines[cy] ?? [], column, scene.width)
    for (let cx = 0; cx < scene.width; cx += 1) {
      const sprite = quadCell(canvas, scene.inks, cx, cy)
      if (sprite !== undefined) { cells[cx] = sprite; continue }
      // A trail pixel lands only where no letter shows: a blank, a space between words, or text not yet uncovered.
      const text = cells[cx]!
      const hidden = cx < wake
      if (!hidden && text.glyph !== ' ') continue
      cells[cx] = quadCell(under, scene.inks, cx, cy) ?? (hidden ? BLANK : text)
    }
    repairWide(cells)
    rows.push(joinCells(cells))
  }
  return rows
}

// ------------------------------------------------------------------------------------------------ motion
/** Ease out: fast at the start, slow into the slot. */
const easeOut = (u: number): number => 1 - (1 - u) ** 2

/** Where the mark's upper-left pixel is at `t`: an ease-out from the right edge into the slot, in whole pixels. */
function flight(t: number, width: number): { readonly x: number, readonly y: number } {
  const from = width * 2 + 2
  const u = Math.min(1, Math.max(0, t / FLY_IN_FLIGHT_MS))
  return { x: Math.round(from * (1 - easeOut(u))), y: 0 }
}

/** Whether the wings are up at `t`: a fast beat in flight, then two slow beats after landing, then rest. */
function wingsUp(t: number): boolean {
  if (t < FLY_IN_FLIGHT_MS) return Math.floor(t / 55) % 2 === 1
  const after = t - FLY_IN_FLIGHT_MS
  return (after >= 110 && after < 190) || (after >= 300 && after < 380)
}

/** A fixed scatter in [0, 1) for sample `n`, so a replay draws the same trail. */
function jitter(n: number): number {
  return ((((n * 9301 + 49297) % 233280) + 233280) % 233280) / 233280
}

/**
 * The fading trail: two pixels dropped behind the mark every 45 ms of the first two thirds of the flight, each fading
 * through the three trail inks and gone after four steps. A dropped pixel stays where it fell.
 */
function trail(t: number, width: number, markWidth: number, markHeight: number): Canvas {
  const STEP = 45
  const now = Math.floor(t / STEP)
  const under: Canvas = new Map()
  for (let k = 1; k <= 4; k += 1) {
    const ts = (now - k) * STEP
    if (ts < 0 || ts >= FLY_IN_FLIGHT_MS * 0.65) continue
    const key = k === 1 ? 'a' : k === 2 ? 'b' : 'c'
    const n = now - k
    const q = flight(ts, width)
    under.set(`${q.x + markWidth + 1 + Math.round(jitter(n) * 2)},${q.y + 2 + Math.round(jitter(n + 3) * 3)}`, key)
    under.set(`${q.x + markWidth + 3 + Math.round(jitter(n + 7) * 3)},${q.y + 1 + Math.round(jitter(n + 11) * (markHeight - 3))}`, key)
  }
  return under
}

/**
 * The rows of the fly-in at `t` milliseconds since it started; from {@link FLY_IN_TOTAL_MS} on, the rows at rest.
 * @param scene - the mark, its inks, the text beside it, and the width.
 * @param t - the time since the fly-in started.
 * @returns one row per cell row, none wider than the scene's width.
 */
export function flyInRows(scene: MarkScene, t: number): string[] {
  if (t >= FLY_IN_TOTAL_MS) return restRows(scene)
  const markWidth = scene.rows[0]?.length ?? 0
  const at = flight(t, scene.width)
  const canvas: Canvas = new Map()
  stamp(canvas, wingsUp(t) ? scene.beat : scene.rows, at.x, at.y)
  const under = trail(t, scene.width, markWidth, scene.rows.length)
  // The text shows only where the mark has passed: right of its trailing edge.
  return composeRows(scene, canvas, under, Math.floor((at.x + markWidth) / 2))
}

// ------------------------------------------------------------------------------------------------ centered stage
/**
 * Enlarge pixel rows: every pixel becomes a `factor` × `factor` block. The row count stays even when `factor` is even
 * or the rows already were.
 * @param rows - the mark's pixels.
 * @param factor - whole-number scale, at least 1.
 * @returns the scaled rows.
 */
export function scaleRows(rows: readonly string[], factor: number): string[] {
  if (factor <= 1) return [...rows]
  return rows.flatMap(row => {
    const wide = [...row].map(key => key.repeat(factor)).join('')
    return Array.from({ length: factor }, () => wide)
  })
}

/** A mark on its own centered stage, as the launch screen draws it. */
export interface MarkStage {
  /** The mark's pixels at rest. */
  readonly rows: readonly string[]
  /** The mark's pixels with the wings up. */
  readonly beat: readonly string[]
  /** The inks, by the order of the pixel keys: body, wings, trail near, trail mid, trail far. */
  readonly inks: readonly MayflyColorFn[]
  /** The viewport width in columns. */
  readonly width: number
  /** The column of the mark's left edge once it has landed. */
  readonly left: number
}

/** The trail behind a mark that enters from the left: pixels dropped to its left, fading as they age. */
function trailBehind(t: number, stage: MarkStage, markHeight: number): Canvas {
  const STEP = 45
  const now = Math.floor(t / STEP)
  const under: Canvas = new Map()
  for (let k = 1; k <= 4; k += 1) {
    const ts = (now - k) * STEP
    if (ts < 0 || ts >= FLY_IN_FLIGHT_MS * 0.65) continue
    const key = k === 1 ? 'a' : k === 2 ? 'b' : 'c'
    const n = now - k
    const q = stageFlight(ts, stage)
    under.set(`${q - 2 - Math.round(jitter(n) * 2)},${Math.round(markHeight / 2) + Math.round(jitter(n + 3) * 3) - 1}`, key)
    under.set(`${q - 4 - Math.round(jitter(n + 7) * 3)},${2 + Math.round(jitter(n + 11) * (markHeight - 3))}`, key)
  }
  return under
}

/** The mark's left pixel at `t`: an ease-out from beyond the left edge into its slot. */
function stageFlight(t: number, stage: MarkStage): number {
  const markWidth = stage.rows[0]?.length ?? 0
  const slot = stage.left * 2
  const u = Math.min(1, Math.max(0, t / FLY_IN_FLIGHT_MS))
  return Math.round(-markWidth + (slot + markWidth) * easeOut(u))
}

/**
 * The cell rows of a mark alone on a stage of `stage.width` columns: at rest in its slot, or `t` milliseconds into the
 * flight from the left edge (the launch screen's fly-in, the banner's mirrored). From {@link FLY_IN_TOTAL_MS} on it
 * rests.
 * @param stage - the mark, its inks, and the slot.
 * @param t - the time since the fly-in started, or undefined for the mark at rest.
 * @returns one row per cell row of the mark, none wider than the stage.
 */
export function stageRows(stage: MarkStage, t?: number): string[] {
  const scene: MarkScene = { rows: stage.rows, beat: stage.beat, inks: stage.inks, gap: 0, lines: [], width: stage.width }
  const canvas: Canvas = new Map()
  if (t === undefined || t >= FLY_IN_TOTAL_MS) {
    stamp(canvas, stage.rows, stage.left * 2, 0)
    return composeRows(scene, canvas, new Map(), 0)
  }
  stamp(canvas, wingsUp(t) ? stage.beat : stage.rows, stageFlight(t, stage), 0)
  return composeRows(scene, canvas, trailBehind(t, stage, stage.rows.length), 0)
}
