/**
 * Renderer-owned animation: one clock, the per-variant glyph tables and cadences of the design (spec §2.3), and the
 * painters of the two motion channels (a loader glyph, a shimmering label). Only painted surfaces request another
 * frame, one timer serves them all, and reduced motion freezes every channel on its first frame.
 *
 * @module @ephemeral-ai/mayfly/core/ui-loader-animation
 */

import type { MayflyLoaderVariant } from '@ephemeral-ai/mayfly-ui'
import { ASCII_SPINNER_FRAMES, type MayflyGlyphMode } from './glyphs.ts'
import type { MayflySemanticColors } from './types.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** One clock step: every channel moves on it. */
export const LOADER_FRAME_MS = 100

/** The longest a step waits for a slow frame: below one frame a second the motion is no longer worth its repaint. */
export const LOADER_MAX_FRAME_MS = 1000

/** The frames of the three stepping variants, one cell each. */
export const LOADER_FRAMES: Readonly<Record<'bloom' | 'fill' | 'gap', readonly string[]>> = Object.freeze({
  bloom: Object.freeze(['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']),
  fill: Object.freeze(['⡀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿', '⣷', '⣶', '⣦', '⣤', '⣄']),
  gap: Object.freeze(['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']),
})

/** How bright each of the breath's six shades is, dim to bright to dim (1 is the tone itself). */
export const BREATH_LEVELS: readonly number[] = Object.freeze([0.25, 0.5, 0.8, 1, 0.8, 0.5])

/** Clock steps per breath shade: 400 ms. */
export const BREATH_STEPS = 4

/** The `shimmer` window is this many letters wide, centred on the sweep. */
export const SHIMMER_WINDOW = 3

/** The first-loaders' variants draw the gap spinner. */
export function loaderVariant(variant: MayflyLoaderVariant | 'braille' | 'tide' | undefined): MayflyLoaderVariant {
  return variant === undefined || variant === 'braille' || variant === 'tide' ? 'gap' : variant
}

/** The step of a stepping variant at a clock frame (a reduced-motion caller passes frame 0). */
export function loaderFrameGlyph(variant: 'bloom' | 'fill' | 'gap', frame: number): string {
  const frames = LOADER_FRAMES[variant]
  return frames[frame % frames.length]!
}

/** Which breath shade a clock frame shows. */
export function breathLevel(frame: number): number {
  return BREATH_LEVELS[Math.floor(frame / BREATH_STEPS) % BREATH_LEVELS.length]!
}

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) opens the palette's SGR sequence
const TRUECOLOR = /^\x1b\[38;2;(\d+);(\d+);(\d+)m/u

/** The RGB a palette color function paints with, or undefined for a weight-only or non-truecolor function. */
function rgbOf(paint: (text: string) => string): readonly [number, number, number] | undefined {
  const match = TRUECOLOR.exec(paint('x'))
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * The colour of a breath shade: the `primary` tone blended toward the palette's deepest gray by `level`, so the
 * brightest shade is `primary` itself. A palette that paints no truecolor (monochrome) has no shades and paints the tone.
 */
export function breathPaint(colors: Pick<MayflySemanticColors, 'primary' | 'textMuted'>, level: number): (text: string) => string {
  const tone = rgbOf(colors.primary)
  const floor = rgbOf(colors.textMuted)
  if (tone === undefined || floor === undefined) return colors.primary
  const [r, g, b] = tone.map((channel, index) => Math.round(floor[index]! + (channel - floor[index]!) * level))
  return text => `\x1b[38;2;${String(r)};${String(g)};${String(b)}m${text}\x1b[39m`
}

/** What a loader cell is painted with. */
export interface LoaderCellOptions {
  readonly colors: Pick<MayflySemanticColors, 'primary' | 'textMuted'>
  /** The glyph vocabulary; ASCII swaps every stepping variant for `- \ | /`. */
  readonly glyphs?: MayflyGlyphMode | undefined
  /** Reduced motion freezes the cell on its first frame. */
  readonly reducedMotion?: boolean | undefined
}

/** One loader cell, painted: a stepping variant's glyph in `primary`, or the breath's `●` in its current shade. */
export function loaderCell(variant: MayflyLoaderVariant, frame: number, options: LoaderCellOptions): string {
  const at = options.reducedMotion === true ? 0 : frame
  if (variant === 'breath') return breathPaint(options.colors, breathLevel(at))('●')
  if (options.glyphs === 'ascii') return options.colors.primary(ASCII_SPINNER_FRAMES[at % ASCII_SPINNER_FRAMES.length]!)
  return options.colors.primary(loaderFrameGlyph(variant, at))
}

/** The letters a shimmer window covers at a frame: one letter per step, the window sweeping in from before the first. */
export function shimmerWindow(letters: number, frame: number): number {
  return (frame % (letters + SHIMMER_WINDOW * 2)) - SHIMMER_WINDOW
}

/** A label with its shimmer: a three-letter `primary` bold window sweeps over muted letters. */
export function shimmerText(text: string, frame: number, colors: Pick<MayflySemanticColors, 'primary' | 'muted'>, reducedMotion = false): string {
  const letters = [...text]
  const at = shimmerWindow(letters.length, reducedMotion ? 0 : frame)
  return letters.map((letter, index) => Math.abs(index - at) <= 1 ? `\x1b[1m${colors.primary(letter)}\x1b[22m` : colors.muted(letter)).join('')
}

/**
 * The one timer behind every animated surface of a renderer. A surface arms its animation while it paints a moving cell
 * and leaves when it hides, so the timer exists only while something is armed. A caller that wants no sharing gives
 * each animation its own clock.
 */
export class UiAnimationClock {
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly armed = new Set<UiLoaderAnimation>()
  /** When the last tick asked for a repaint, until that repaint paints a moving cell. */
  private askedAt: number | undefined

  /** @param counters - a caller's work sink; it counts the ticks that asked for a repaint. */
  constructor(private readonly counters?: MayflyWorkCounters) {}

  /**
   * Joins the next tick, starting the timer when none is pending. The first cell to paint after a tick shows what that
   * tick's frame cost; the next step waits at least twice as long, so a frame slower than half a step slows the motion
   * down instead of leaving the terminal no time between two repaints to read a key.
   */
  arm(member: UiLoaderAnimation): void {
    this.armed.add(member)
    if (this.timer !== undefined) return
    const cost = this.askedAt === undefined ? 0 : performance.now() - this.askedAt
    this.askedAt = undefined
    this.timer = setTimeout(() => {
      this.timer = undefined
      const due = [...this.armed]
      this.armed.clear()
      let asked = false
      for (const animation of due) {
        if (!animation.fire()) continue
        asked = true
        countWork(this.counters, 'clockTicks')
      }
      if (asked) this.askedAt = performance.now()
    }, Math.max(LOADER_FRAME_MS, Math.min(LOADER_MAX_FRAME_MS, cost * 2)))
  }

  /** Leaves the next tick; the timer is cancelled once nothing is armed. */
  disarm(member: UiLoaderAnimation): void {
    this.armed.delete(member)
    if (this.armed.size === 0) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.askedAt = undefined
    }
  }

  /** Cancels the pending tick and forgets every member. */
  dispose(): void {
    this.armed.clear()
    clearTimeout(this.timer)
    this.timer = undefined
    this.askedAt = undefined
  }
}

export class UiLoaderAnimation {
  private painted = false
  private frameValue = 0

  constructor(private readonly requestRender: () => void, private readonly clock: UiAnimationClock = new UiAnimationClock()) {}

  get frame(): number { return this.frameValue }

  /** A fresh paint/rebind must encounter a loader to keep its clock running. */
  beginFrame(): void { this.painted = false }

  /** All loaders within one surface share a clock, independent of data updates. */
  render(): number {
    this.painted = true
    this.clock.arm(this)
    return this.frameValue
  }

  /**
   * Called by the clock on a tick: a surface that did not paint since its last frame stays out of the next one.
   * @returns whether the tick asked for a repaint.
   */
  fire(): boolean {
    if (!this.painted) return false
    this.painted = false
    this.frameValue++
    this.requestRender()
    return true
  }

  /** Hiding, deactivation, or renderer disposal cancels the pending repaint. */
  stop(): void {
    this.clock.disarm(this)
    this.painted = false
  }
}
