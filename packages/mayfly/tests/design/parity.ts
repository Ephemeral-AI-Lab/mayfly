/**
 * Strict cell parity between the design prototype and the real renderer (docs/design/implementation-roadmap.md,
 * section 1 rule 1). Both sides are written into a headless terminal and read back as cells; a cell is compared by
 * its character and its style class: the tone, the weight, italic, strike, inverse, and the background. The
 * prototype's truecolor values map to tone names, and the real renderer paints with a probe palette in which every
 * semantic color is a distinct color, so two tones never compare equal by accident.
 */

import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { Terminal } from '@xterm/headless'
import { readFileSync } from 'node:fs'
import type { MayflyUiEvent } from '../../../ui/src/index.ts'
import { DARK_BACKGROUNDS, DARK_FOREGROUNDS } from '../../src/core/theme-dark.ts'
import { colorsFromForegrounds } from '../../src/core/theme-palette.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode, type MayflyUiCompilerOptions } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'
import { DESIGN_DELTAS } from './deltas.ts'

/** The style class of one cell. `tone` is a `MayflyTone`, `rgb:r,g,b` for an unmapped color, or `token:<name>`. */
export interface ParityCell {
  readonly ch: string
  readonly tone: string
  readonly bold: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly inverse: boolean
  readonly bg: string
}

export interface ParityDiff {
  readonly row: number
  readonly col: number
  readonly expected: string
  readonly actual: string
}

/** A waiver for a rectangle of cells (inclusive rows and columns), citing the accepted difference it falls under. */
export interface ParityWaiver {
  readonly delta: string
  readonly rows?: readonly [number, number]
  readonly cols?: readonly [number, number]
}

const rgbKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b
const hexKey = (hex: string): number => Number.parseInt(hex.slice(1), 16)

/** The prototype's palette (ui-kit.mjs), keyed by packed RGB. A muted cell is dim with no foreground. */
const PROTOTYPE_TONES = new Map<number, string>([
  [rgbKey(154, 134, 230), 'primary'],
  [rgbKey(120, 190, 230), 'accent'],
  [rgbKey(130, 160, 240), 'user'],
  [rgbKey(110, 200, 140), 'success'],
  [rgbKey(230, 190, 90), 'warning'],
  [rgbKey(230, 110, 110), 'danger'],
])

/** The prototype's backgrounds: the diff bands and the user prompt band. */
const PROTOTYPE_BACKGROUNDS = new Map<number, string>([
  [rgbKey(66, 30, 36), 'diffRemovedBg'],
  [rgbKey(28, 58, 40), 'diffAddedBg'],
  [rgbKey(34, 36, 60), 'selectedBg'],
])

/**
 * How the real compiler paints each tone (`paintTone` in core/ui-patterns.ts), plus the palette tokens the prototype
 * draws with one of its tones: strong text is its default tone (the weight is compared separately), the deepest gray is
 * its dim muted, a frame is drawn in the focus color (`primary`) on an overlay and in the quiet color (dim) inline, and
 * a diff's gutter and markers are muted and its removed and added code is in the danger and success tones.
 */
const REAL_TONE_TOKENS: Readonly<Record<string, string>> = {
  text: 'default',
  textStrong: 'default',
  muted: 'muted',
  textMuted: 'muted',
  border: 'muted',
  borderFocus: 'primary',
  diffGutter: 'muted',
  diffMeta: 'muted',
  diffRemoved: 'danger',
  diffAdded: 'success',
  primary: 'primary',
  accent: 'accent',
  roleUser: 'user',
  success: 'success',
  warning: 'warning',
  error: 'danger',
}

const FOREGROUND_TOKENS = Object.keys(DARK_FOREGROUNDS)
const BACKGROUND_TOKENS = Object.keys(DARK_BACKGROUNDS)
const PROBE_COLORS = new Map<string, number>()
const PROBE_TOKENS = new Map<number, string>()
;[...FOREGROUND_TOKENS, ...BACKGROUND_TOKENS].forEach((token, index) => {
  const color = rgbKey(24 + ((index * 37) % 200), 40 + ((index * 91) % 190), 60 + ((index * 53) % 170))
  PROBE_COLORS.set(token, color)
  PROBE_TOKENS.set(color, token)
})
const probeHex = (token: string): string => `#${PROBE_COLORS.get(token)!.toString(16).padStart(6, '0')}`

/**
 * The breath's shades (roadmap slice 1.3): the prototype blends its violet toward gray 60 by 0.25, 0.5, and 0.8, the
 * renderer blends the palette's `primary` toward its `textMuted`. A shade is the class `breath:<level>`, so the two
 * compare equal when they sit at the same brightness (the full level is `primary` itself).
 */
const BREATH_SHADES = [0.25, 0.5, 0.8] as const
const channels = (color: number): readonly [number, number, number] => [color >> 16, (color >> 8) & 255, color & 255]
const blend = (tone: readonly number[], floor: readonly number[], level: number): number => rgbKey(...tone.map((channel, index) => Math.round(floor[index]! + (channel - floor[index]!) * level)) as [number, number, number])
const PROTOTYPE_SHADES = new Map<number, string>(BREATH_SHADES.map(level => [blend([154, 134, 230], [60, 60, 60], level), `breath:${String(level)}`]))
const REAL_SHADES = new Map<number, string>(BREATH_SHADES.map(level => [blend(channels(PROBE_COLORS.get('primary')!), channels(PROBE_COLORS.get('textMuted')!), level), `breath:${String(level)}`]))

/** A palette in which every semantic color is a distinct truecolor, so the cell's color names its token. */
export const PROBE_PALETTE: MayflySemanticColors = colorsFromForegrounds(
  Object.fromEntries(FOREGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_FOREGROUNDS,
  Object.fromEntries(BACKGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_BACKGROUNDS,
  Array.from({ length: 8 }, () => probeHex('text')),
)

/** The tokens the probe palette paints, with the packed color each uses. */
export const PROBE_TOKEN_COLORS: ReadonlyMap<string, number> = PROBE_COLORS

type Side = 'prototype' | 'real'

function toneOf(side: Side, foreground: number | undefined, dim: boolean): string {
  if (foreground === undefined) return dim ? 'muted' : 'default'
  if (side === 'prototype') return PROTOTYPE_TONES.get(foreground) ?? PROTOTYPE_SHADES.get(foreground) ?? `rgb:${[foreground >> 16, (foreground >> 8) & 255, foreground & 255].join(',')}`
  const token = PROBE_TOKENS.get(foreground)
  if (token === undefined) return REAL_SHADES.get(foreground) ?? `rgb:${[foreground >> 16, (foreground >> 8) & 255, foreground & 255].join(',')}`
  return REAL_TONE_TOKENS[token] ?? `token:${token}`
}

function backgroundOf(side: Side, background: number | undefined): string {
  if (background === undefined) return 'none'
  return (side === 'prototype' ? PROTOTYPE_BACKGROUNDS.get(background) : PROBE_TOKENS.get(background)) ?? `rgb:${[background >> 16, (background >> 8) & 255, background & 255].join(',')}`
}

/** Writes rows into a headless terminal of the given width and reads every cell back as its character and class. */
export async function parseCells(rows: readonly string[], columns: number, side: Side): Promise<ParityCell[][]> {
  const terminal = new Terminal({ cols: columns, rows: Math.max(1, rows.length), scrollback: 0, allowProposedApi: true })
  // pi-tui takes the hardware cursor marker out of a row before writing it, so the real side does too.
  const written = side === 'real' ? rows.map(row => row.replaceAll(CURSOR_MARKER, '')) : rows
  await new Promise<void>(resolve => { terminal.write(written.map(row => `${row}\x1b[0m`).join('\r\n'), resolve) })
  const buffer = terminal.buffer.active
  const result: ParityCell[][] = []
  for (let y = 0; y < rows.length; y += 1) {
    const line = buffer.getLine(y)
    const cells: ParityCell[] = []
    for (let x = 0; x < columns; x += 1) {
      const cell = line?.getCell(x)
      if (cell === undefined || cell.getWidth() === 0) continue
      const foreground = cell.isFgRGB() ? cell.getFgColor() : undefined
      const background = cell.isBgRGB() ? cell.getBgColor() : undefined
      cells.push({
        ch: cell.getChars() === '' ? ' ' : cell.getChars(),
        tone: toneOf(side, foreground, cell.isDim() !== 0),
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        strike: cell.isStrikethrough() !== 0,
        inverse: cell.isInverse() !== 0,
        bg: backgroundOf(side, background),
      })
    }
    result.push(cells)
  }
  terminal.dispose()
  return result
}

const blank = (cell: ParityCell): boolean => cell.ch === ' ' && cell.tone === 'default' && !cell.inverse && cell.bg === 'none' && !cell.strike

const describe = (cell: ParityCell | undefined): string => cell === undefined
  ? '(none)'
  : `${JSON.stringify(cell.ch)} ${cell.tone}${cell.bold ? ' bold' : ''}${cell.italic ? ' italic' : ''}${cell.strike ? ' strike' : ''}${cell.inverse ? ' inverse' : ''}${cell.bg === 'none' ? '' : ` on ${cell.bg}`}`

const sameClass = (left: ParityCell, right: ParityCell): boolean => left.ch === right.ch && left.tone === right.tone && left.bold === right.bold
  && left.italic === right.italic && left.strike === right.strike && left.inverse === right.inverse && left.bg === right.bg

/**
 * Compares two cell grids, ignoring trailing blank cells. Every waiver must cite an accepted difference
 * (`DESIGN_DELTAS`); the cells it covers are skipped.
 */
export function compareCells(expected: readonly (readonly ParityCell[])[], actual: readonly (readonly ParityCell[])[], waivers: readonly ParityWaiver[] = []): ParityDiff[] {
  for (const waiver of waivers) if (!DESIGN_DELTAS.some(delta => delta.id === waiver.delta)) throw new Error(`unknown accepted difference ${waiver.delta}`)
  const waived = (row: number, col: number): boolean => waivers.some(waiver => (waiver.rows === undefined || (row >= waiver.rows[0] && row <= waiver.rows[1]))
    && (waiver.cols === undefined || (col >= waiver.cols[0] && col <= waiver.cols[1])))
  const trimmed = (cells: readonly ParityCell[] | undefined): readonly ParityCell[] => {
    let end = cells?.length ?? 0
    while (end > 0 && blank(cells![end - 1]!)) end -= 1
    return cells?.slice(0, end) ?? []
  }
  const diffs: ParityDiff[] = []
  const rows = Math.max(expected.length, actual.length)
  for (let row = 0; row < rows; row += 1) {
    const left = trimmed(expected[row])
    const right = trimmed(actual[row])
    for (let col = 0; col < Math.max(left.length, right.length); col += 1) {
      const a = left[col]
      const b = right[col]
      if (a !== undefined && b !== undefined && sameClass(a, b)) continue
      if (a === undefined && b === undefined) continue
      if (waived(row, col)) continue
      diffs.push({ row, col, expected: describe(a), actual: describe(b) })
    }
  }
  return diffs
}

export interface GoldenFrame {
  readonly label: string
  readonly rows: readonly string[]
}

/** Reads a golden `.ansi` file (see script/design-golden.mjs) into one frame per step. */
export function readGoldenFrames(directory: string, name: string): GoldenFrame[] {
  const text = readFileSync(new URL(`./golden/${directory}/${name}.ansi`, import.meta.url), 'utf8')
  const frames: GoldenFrame[] = []
  const pattern = /^--- after (.*) ---\n/gmu
  const marks = [...text.matchAll(pattern)]
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length
    const end = index + 1 < marks.length ? marks[index + 1]!.index : text.length
    const body = text.slice(start, end).replace(/\n$/u, '')
    frames.push({ label: mark[1]!, rows: body === '(no frame)' ? [] : body.split('\n') })
  })
  return frames
}

/** The component seam the compiler needs, built from the real width helpers and the shared fake editor. */
export function parityComponents(): MayflyComponents {
  return {
    visibleWidth,
    wrapText: wrapTextWithAnsi,
    truncateToWidth,
    sliceByColumn,
    createEditor: createFakeEditor,
    createMarkdown: (options?: { text?: string }) => {
      let value = options?.text ?? ''
      return { setText: (text: string) => { value = text }, render: (width: number) => wrapTextWithAnsi(value, width), invalidate: () => {} }
    },
  } as unknown as MayflyComponents
}

/** A surface compiled with the real compiler under the probe palette, driven the way a terminal drives it. */
export interface RealSurface {
  /** Paints the surface at its width. */
  render(): string[]
  /** Sends a key to the focused control, then paints. */
  press(key: string): string[]
  dispose(): void
}

export interface RealSurfaceOptions {
  readonly components: MayflyComponents
  readonly events?: (event: MayflyUiEvent) => void
  readonly overrides?: Partial<MayflyUiCompilerOptions>
}

/** Compiles a node the way `script/shots/render.mjs` does, with interaction state so keys work. */
export function createRealSurface(node: unknown, width: number, options: RealSurfaceOptions): RealSurface {
  const model = new UiSurfaceModel('parity', {
    scope: { kind: 'app', targetId: 'parity' }, source: [], revision: 1, update: { reason: 'data' },
    node: node as never,
    events: { prepare: async event => { options.events?.(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
    definition: { onEvent: {} },
  } as never)
  const runtime = new MayflyUiSurfaceRuntime(model)
  const viewport = { columns: width, rows: 40 }
  const result = compileMayflyUiSurfaceNode(model.node!, {
    components: options.components,
    colors: PROBE_PALETTE,
    getViewport: () => viewport,
    screenMode: 'alternate',
    emit: event => options.events?.(event),
    contextHints: { enabled: true },
    ...options.overrides,
    surfaceRuntime: runtime,
  })
  if (!result.ok) throw new Error(result.message)
  const surface = result.value
  if (surface.focusTarget !== null) surface.focusTarget.focused = true
  return {
    render: () => surface.component.render(width),
    press: key => { surface.focusTarget?.handleInput?.(key); return surface.component.render(width) },
    dispose: () => { runtime.dispose(); model.dispose() },
  }
}
