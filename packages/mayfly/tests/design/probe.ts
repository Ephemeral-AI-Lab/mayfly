/**
 * The real renderer under the probe palette, and its frames as cell-grid goldens. Every semantic color of the probe
 * palette is a distinct truecolor, so a grid names the token each cell is painted with (`fg:primary`, `bg:selectedBg`)
 * instead of a theme's RGB value. The design scenes drive real surfaces through their walks and compare each frame with
 * the grid committed under `tests/design/frames/`, the visual record of Phase 1 until the foundation review replaces it
 * (docs/design/implementation-roadmap.md, Phase 2b).
 */

import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { Terminal } from '@xterm/headless'
import { expect } from 'vitest'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { readGrid, serializeGrid } from '../../../../script/scenarios/grid.mjs'
import { DARK_BACKGROUNDS, DARK_FOREGROUNDS } from '../../src/core/theme-dark.ts'
import { colorsFromForegrounds } from '../../src/core/theme-palette.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode } from '../../src/core/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'

const rgbKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

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

/** A palette in which every semantic color is a distinct truecolor, so the cell's color names its token. */
export const PROBE_PALETTE: MayflySemanticColors = colorsFromForegrounds(
  Object.fromEntries(FOREGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_FOREGROUNDS,
  Object.fromEntries(BACKGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_BACKGROUNDS,
  Array.from({ length: 8 }, () => probeHex('text')),
)

/** The tokens the probe palette paints, with the packed color each uses. */
export const PROBE_TOKEN_COLORS: ReadonlyMap<string, number> = PROBE_COLORS

/** The component seam the compiler needs, built from the real width helpers and the shared fake editor. */
export function probeComponents(): MayflyComponents {
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
  readonly overrides?: Partial<Omit<Parameters<typeof compileMayflyUiSurfaceNode>[1], 'surfaceRuntime'>>
  /** Whether the surface holds focus. Default true. */
  readonly focused?: boolean
}

/** Compiles a node the way `script/shots/render.mjs` does, with interaction state so keys work. */
export function createRealSurface(node: unknown, width: number, options: RealSurfaceOptions): RealSurface {
  const model = new UiSurfaceModel('probe', {
    scope: { kind: 'app', targetId: 'probe' }, source: [], revision: 1, update: { reason: 'data' },
    node: node as never,
    events: { prepare: async (event: MayflyUiEvent) => { options.events?.(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
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
  if (surface.focusTarget !== null) surface.focusTarget.focused = options.focused ?? true
  return {
    render: () => surface.component.render(width),
    press: key => { surface.focusTarget?.handleInput?.(key); return surface.component.render(width) },
    dispose: () => { runtime.dispose(); model.dispose() },
  }
}

/** The muted caption every scene prints above its body. */
export const caption = (text: string): MayflyUiNode => ui.text(text, { tone: 'muted' })

/** Paints a static node at a width with the real compiler, the probe palette, and no focus. */
export function paint(node: MayflyUiNode, width: number, components: MayflyComponents = probeComponents()): string[] {
  const result = compileMayflyUiNode(node, {
    components,
    colors: PROBE_PALETTE,
    getViewport: () => ({ columns: width, rows: 200 }),
    screenMode: 'alternate',
    emit: () => {},
  })
  if (!result.ok) throw new Error(result.message)
  return result.value.component.render(width)
}

/** One painted frame: the rows, the columns they are painted into, and what led to them. */
export interface Frame {
  readonly label: string
  readonly rows: readonly string[]
  readonly width: number
}

/**
 * The cell grid of painted rows at `width` columns. The hardware cursor marker pi-tui takes out of a row before
 * writing it becomes the grid's cursor; a row wider than the frame fails instead of wrapping.
 */
export async function frameGrid(rows: readonly string[], width: number): Promise<string> {
  let cursor: readonly [number, number] | null = null
  const written = rows.map((row, index) => {
    const at = row.indexOf(CURSOR_MARKER)
    if (at < 0) return row
    cursor = [index, visibleWidth(row.slice(0, at))]
    return row.replaceAll(CURSOR_MARKER, '')
  })
  const wide = written.findIndex(row => visibleWidth(row) > width)
  if (wide >= 0) throw new Error(`row ${String(wide)} is ${String(visibleWidth(written[wide]!))} columns, wider than ${String(width)} columns`)
  const terminal = new Terminal({ cols: width, rows: Math.max(1, rows.length), scrollback: 0, allowProposedApi: true })
  await new Promise<void>(resolve => { terminal.write(written.map(row => `${row}\x1b[0m`).join('\r\n'), resolve) })
  const grid = serializeGrid(readGrid(terminal, { cursor, colorName: rgb => PROBE_TOKENS.get(rgb) }))
  terminal.dispose()
  return grid
}

/** Compares frames with the grid golden `tests/design/frames/<name>.grid`; `vitest -u` writes it. */
export async function expectFrames(name: string, frames: readonly Frame[]): Promise<void> {
  const parts: string[] = []
  for (const frame of frames) parts.push(`## ${frame.label}\n${await frameGrid(frame.rows, frame.width)}`)
  await expect(`${parts.join('\n')}\n`).toMatchFileSnapshot(`./frames/${name}.grid`)
}
