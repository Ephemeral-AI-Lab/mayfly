/**
 * The quadrant-block mark renderer and its two fly-ins: pixel-to-cell
 * composition (two inks in a cell, ties, wide graphemes, dropped trailing
 * blanks), the wing lift, scaling, the banner's right-to-left wake, and the
 * launch screen's left-to-right centered stage with its fading trail.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  FLY_IN_FLIGHT_MS,
  FLY_IN_FRAME_MS,
  FLY_IN_TOTAL_MS,
  flyInRows,
  liftWings,
  markColumns,
  restRows,
  scaleRows,
  stageRows,
  type MarkScene,
  type MarkStage,
  type MarkTextRun,
} from '../../src/core/quad-mark.ts'
import { MARK_BEAT, MARK_ROWS } from '../../src/transcript/banner-art.ts'
import { visibleWidth } from '../../src/core/width.ts'

const QUADRANT = /[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/u

const [body, wings, near, mid, far] = [
  (text: string) => `<B>${text}</B>`,
  (text: string) => `<W>${text}</W>`,
  (text: string) => `<A>${text}</A>`,
  (text: string) => `<M>${text}</M>`,
  (text: string) => `<F>${text}</F>`,
]
const INKS = [body, wings, near, mid, far]

const text = (value: string, paint: (input: string) => string = input => `<T>${input}</T>`): MarkTextRun => ({ text: value, paint })
const plainText = (value: string): MarkTextRun => ({ text: value, paint: input => input })

function scene(over: Partial<MarkScene> = {}): MarkScene {
  const rows = over.rows ?? ['BW', 'T.']
  return {
    rows,
    beat: over.beat ?? liftWings(rows),
    inks: over.inks ?? INKS,
    gap: over.gap ?? 1,
    lines: over.lines ?? [[text('hi')]],
    width: over.width ?? 20,
  }
}

describe('liftWings', () => {
  it('raises each wing pixel into the row above and clears the uncovered wing', () => {
    expect(liftWings(['WW.', '.W.', 'B..'])).toEqual(['.W.', '...', 'B..'])
  })

  it('leaves body and antennae pixels alone', () => {
    expect(liftWings(['BT', '..'])).toEqual(['BT', '..'])
  })
})

describe('markColumns and scaleRows', () => {
  it('counts one cell per two pixel columns, rounding up', () => {
    expect(markColumns([])).toBe(0)
    expect(markColumns(['..'])).toBe(1)
    expect(markColumns(['...'])).toBe(2)
    expect(markColumns(['....'])).toBe(2)
    expect(markColumns(MARK_ROWS)).toBe(13)
  })

  it('copies the rows untouched for a factor of one or less', () => {
    const rows = ['BW', 'T.']
    const copied = scaleRows(rows, 1)
    expect(copied).toEqual(rows)
    expect(copied).not.toBe(rows)
    expect(scaleRows(rows, 0)).toEqual(rows)
  })

  it('doubles every pixel horizontally and repeats every row vertically', () => {
    expect(scaleRows(['BW', 'T.'], 2)).toEqual(['BBWW', 'BBWW', 'TT..', 'TT..'])
    expect(scaleRows(MARK_ROWS, 2)).toHaveLength(16)
    expect(markColumns(scaleRows(MARK_ROWS, 2))).toBe(26)
  })
})

describe('restRows', () => {
  it('paints a cell by its majority ink and keeps two inks in one cell', () => {
    const rows = restRows(scene())
    // B/T (body) own the two left pixels: mask upper-left + lower-left.
    expect(rows[0]).toContain('<B>▌</B>')
    expect(rows[0]).toContain('<T>hi</T>')
    expect(rows[0]).not.toContain('<W>')
  })

  it('breaks an ink tie toward the nearer ink in the palette order', () => {
    const rows = restRows(scene({ rows: ['B.', '.W'], gap: 0, lines: [] }))
    // One body pixel and one wing pixel: the body ink wins and paints only its own quadrant.
    expect(rows[0]).toContain('<B>▘</B>')
    expect(rows[0]).not.toContain('<W>')
  })

  it('picks the ink covering more pixels even when it is farther down the palette', () => {
    const rows = restRows(scene({ rows: ['BW', 'WW'], gap: 0, lines: [] }))
    expect(rows[0]).toContain('<W>▟</W>')
    expect(rows[0]).not.toContain('<B>')
  })

  it('draws an uninked mark plain when the palette has no function for its ink', () => {
    const rows = restRows(scene({ inks: [], gap: 0, lines: [] }))
    expect(rows[0]).toContain('▌')
    expect(rows[0]).not.toContain('<')
  })

  it('puts one blank gap column between the mark and each line', () => {
    const rows = restRows(scene({ width: 8, lines: [[text('hi')], [text('there')]] }))
    expect(rows[0]).toBe('<B>▌</B> <T>hi</T>')
    // The second line extends the mark's cell-row count.
    expect(rows[1]).toBe('  <T>there</T>')
  })

  it('groups neighboring cells with one paint into a single call', () => {
    const paint = vi.fn((value: string) => `<one>${value}</one>`)
    const rows = restRows(scene({ rows: [], gap: 0, lines: [[{ text: 'ab', paint }, { text: 'cd', paint }]], width: 8 }))
    expect(rows[0]).toBe('<one>abcd</one>')
    expect(paint).toHaveBeenCalledOnce()
    expect(paint).toHaveBeenCalledWith('abcd')
  })

  it('cuts a line at the right edge rather than wrapping it', () => {
    const rows = restRows(scene({ rows: [], gap: 0, lines: [[text('abcd')]], width: 2 }))
    expect(rows[0]).toBe('<T>ab</T>')
  })

  it('attaches a zero-width grapheme to the preceding cell and skips one at the start', () => {
    const attached = restRows(scene({ rows: [], gap: 0, lines: [[text('a\u200b')]], width: 4 }))
    expect(attached[0]).toBe('<T>a\u200b</T>')
    const leading = restRows(scene({ rows: [], gap: 0, lines: [[text('\u200bxyz')]], width: 4 }))
    expect(leading[0]).toBe('<T>xyz</T>')
  })

  it('paints a wide grapheme once across its two cells', () => {
    const rows = restRows(scene({ rows: [], gap: 0, lines: [[plainText('你')]], width: 4 }))
    expect(rows[0]).toBe('你')
    expect(visibleWidth(rows[0]!)).toBe(2)
  })

  it('blanks the orphaned half when a mark takes one half of a wide grapheme', () => {
    // The first row is one cell wide, but the second row's final pixel lands in row 0's second cell.
    const rows = restRows(scene({ rows: ['..', '...W'], gap: 0, lines: [[text('你')]], width: 5 }))
    expect(rows.join('')).not.toContain('你')
    expect(rows[0]).toContain('▗')
  })

  it('blanks a wide grapheme whose continuation a mark took', () => {
    const rows = restRows(scene({ rows: ['..', '.....W'], gap: 0, lines: [[text('你')]], width: 5 }))
    expect(rows.join('')).not.toContain('你')
    expect(rows[0]).toContain('▗')
  })

  it('keeps every row within the scene width and drops trailing blanks', () => {
    const rows = restRows(scene({ rows: MARK_ROWS, beat: MARK_BEAT, inks: [], gap: 2, width: 50, lines: [[plainText('a')], [plainText('b')], [plainText('c')], [plainText('d')]] }))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(50)
      expect(row.endsWith(' ')).toBe(false)
    }
  })
})

describe('flyInRows', () => {
  const art = (): MarkScene => scene({
    rows: MARK_ROWS,
    beat: MARK_BEAT,
    gap: 2,
    width: 100,
    lines: [[text('mayfly')], [text('ephemeral agents, enduring works')], [text('m · p')], [text('~/dev')]],
  })

  it('rests from the total time on', () => {
    expect(flyInRows(art(), FLY_IN_TOTAL_MS)).toEqual(restRows(art()))
    expect(flyInRows(art(), FLY_IN_TOTAL_MS + 500)).toEqual(restRows(art()))
  })

  it('starts entirely off screen with the text hidden behind the wake', () => {
    const rows = flyInRows(art(), 0)
    expect(rows).toHaveLength(4)
    expect(rows.join('')).toBe('')
  })

  it('measures an empty mark as zero pixels wide', () => {
    const rows = flyInRows(scene({ rows: [], beat: [], inks: [], gap: 0, lines: [[plainText('x')]], width: 4 }), 0)
    expect(rows.every(row => visibleWidth(row) <= 4)).toBe(true)
  })

  it('flies in with the text appearing only in the wake and lands', () => {
    const flying = flyInRows(art(), 550)
    expect(QUADRANT.test(flying.join('\n'))).toBe(true)
    expect(flying.join('\n')).not.toContain('mayfly')
    expect(flying.join('\n')).toContain('works')
    const landed = flyInRows(art(), FLY_IN_FLIGHT_MS)
    expect(landed.join('\n')).toContain('mayfly')
    expect(landed.join('\n')).toContain('ephemeral agents, enduring works')
  })

  it('flaps the fast beat in flight and the slow beats after landing', () => {
    const flutter = flyInRows(art(), 55)
    const glide = flyInRows(art(), 60)
    expect(flutter).not.toEqual(glide)
    const firstBeat = flyInRows(art(), FLY_IN_FLIGHT_MS + 120)
    const between = flyInRows(art(), FLY_IN_FLIGHT_MS + 250)
    expect(firstBeat).not.toEqual(between)
    const secondBeat = flyInRows(art(), FLY_IN_FLIGHT_MS + 320)
    expect(secondBeat).not.toEqual(between)
    // After the second beat the mark rests even before the total time.
    expect(flyInRows(art(), FLY_IN_TOTAL_MS - 1)).toEqual(restRows(art()))
  })

  it('draws the trail at the three fade steps and drops it before the flight starts', () => {
    expect(flyInRows(art(), 0).join('')).not.toContain('<A>')
    expect(flyInRows(art(), 135).join('')).toContain('<A>')
    const midTrail = flyInRows(art(), 180).join('')
    expect(midTrail).toContain('<M>')
    const farTrail = flyInRows(art(), 225).join('')
    expect(farTrail).toContain('<F>')
    // Past the trail window every sample is gone.
    expect(flyInRows(art(), FLY_IN_FLIGHT_MS - 1).join('')).not.toContain('<F>')
  })

  it('sweeps the flight without ever painting past the scene width', () => {
    const plain = { ...art(), inks: [] }
    for (let t = 0; t <= FLY_IN_TOTAL_MS + FLY_IN_FRAME_MS; t += FLY_IN_FRAME_MS) {
      for (const row of flyInRows(plain, t)) expect(visibleWidth(row)).toBeLessThanOrEqual(100)
    }
  })
})

describe('stageRows', () => {
  const stage = (over: Partial<MarkStage> = {}): MarkStage => ({
    rows: MARK_ROWS,
    beat: MARK_BEAT,
    inks: INKS,
    width: 40,
    left: 13,
    ...over,
  })

  it('rests in its centered slot without a time', () => {
    const rows = stageRows(stage())
    expect(rows).toHaveLength(4)
    expect(rows[0]!.slice(0, 13)).toBe(' '.repeat(13))
    expect(QUADRANT.test(rows[0]!)).toBe(true)
    expect(stageRows(stage(), FLY_IN_TOTAL_MS)).toEqual(rows)
  })

  it('enters from beyond the left edge, lands in the slot, and beats its wings', () => {
    expect(stageRows(stage(), 0).join('')).toBe('')
    const landing = stageRows(stage(), FLY_IN_FLIGHT_MS)
    expect(landing).toEqual(stageRows(stage()))
    const inFlight = stageRows(stage(), 550)
    expect(QUADRANT.test(inFlight.join('\n'))).toBe(true)
    expect(inFlight).not.toEqual(landing)
    expect(stageRows(stage(), FLY_IN_FLIGHT_MS + 120)).not.toEqual(stageRows(stage(), FLY_IN_FLIGHT_MS + 250))
  })

  it('drops trail pixels behind the mark as it enters', () => {
    const withTrail = stageRows(stage(), 500).join('\n')
    expect(withTrail).toContain('<A>')
    expect(stageRows(stage(), 0).join('')).not.toContain('<A>')
  })

  it('measures an empty mark as zero pixels wide and still paints its text', () => {
    const rows = stageRows(stage({ rows: [], beat: [], inks: [], width: 4, left: 0 }), 0)
    expect(rows).toEqual([])
  })

  it('keeps the stage width when the slot and mark do not fit', () => {
    const narrow = stageRows(stage({ width: 5, left: 0, inks: [] }))
    for (const row of narrow) expect(visibleWidth(row)).toBeLessThanOrEqual(5)
  })

  it('sweeps the stage flight at every frame within the stage width', () => {
    const plain = stage({ inks: [] })
    for (let t = 0; t <= FLY_IN_TOTAL_MS; t += FLY_IN_FRAME_MS) {
      for (const row of stageRows(plain, t)) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    }
  })
})
