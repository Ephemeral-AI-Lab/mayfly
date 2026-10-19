/**
 * The real compiler under a probe palette whose semantic colors are distinct
 * truecolors, so a test can name the token a cell was painted with instead of a
 * theme's RGB value. The surviving core tests use this seam; the design grid
 * scenes and their frames are retired.
 */

import type { MayflyUiEvent, MayflyUiNode } from '../../../ui/src/index.ts'
import { DARK_BACKGROUNDS, DARK_FOREGROUNDS } from '../../src/core/theme/theme-dark.ts'
import { colorsFromForegrounds } from '../../src/core/theme/theme-palette.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../src/core/ui/compile/ui-compiler.ts'
import { UiSurfaceModel } from '../../src/core/ui/state/ui-interaction-surface.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/text/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'

const rgbKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

const FOREGROUND_TOKENS = Object.keys(DARK_FOREGROUNDS)
const BACKGROUND_TOKENS = Object.keys(DARK_BACKGROUNDS)
const PROBE_COLORS = new Map<string, number>()
;[...FOREGROUND_TOKENS, ...BACKGROUND_TOKENS].forEach((token, index) => {
  PROBE_COLORS.set(token, rgbKey(24 + ((index * 37) % 200), 40 + ((index * 91) % 190), 60 + ((index * 53) % 170)))
})
const probeHex = (token: string): string => `#${PROBE_COLORS.get(token)!.toString(16).padStart(6, '0')}`

/** A palette in which every semantic color is a distinct truecolor, so the cell's color names its token. */
export const PROBE_PALETTE: MayflySemanticColors = colorsFromForegrounds(
  Object.fromEntries(FOREGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_FOREGROUNDS,
  Object.fromEntries(BACKGROUND_TOKENS.map(token => [token, probeHex(token)])) as typeof DARK_BACKGROUNDS,
  Array.from({ length: 8 }, () => probeHex('text')),
)

/** The component seam the compiler needs, built from the real width helpers and the shared fake editor. */
export function probeComponents(): MayflyComponents {
  return {
    visibleWidth,
    wrapText: wrapTextWithAnsi,
    truncateToWidth,
    sliceByColumn,
    createEditor: createFakeEditor,
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
    node: node as MayflyUiNode,
    events: { prepare: async (event: MayflyUiEvent) => { options.events?.(event); return { reply: { kind: 'completed' as const }, publish: () => true } } },
    definition: { onEvent: {} },
  } as never)
  const runtime = new MayflyUiSurfaceRuntime(model)
  const viewport = { columns: width, rows: 40 }
  const result = compileMayflyUiSurfaceNode(model.node!, {
    components: options.components,
    colors: PROBE_PALETTE,
    getViewport: () => viewport,
    bounded: true,
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
