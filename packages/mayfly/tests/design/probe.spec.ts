/** The grid goldens' terms: every probe token is its own color, the hardware cursor is recorded, and a row never wraps. */
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { PROBE_PALETTE, PROBE_TOKEN_COLORS, frameGrid } from './probe.ts'

describe('the probe palette', () => {
  it('paints every semantic color as a distinct color, so a grid names the token of each cell', async () => {
    expect(new Set(PROBE_TOKEN_COLORS.values()).size).toBe(PROBE_TOKEN_COLORS.size)
    const grid = await frameGrid([`${PROBE_PALETTE.primary('p')}${PROBE_PALETTE.error('e')}${PROBE_PALETTE.diffAddedBg('g')}`], 4)
    expect(grid.split('\n').at(-1)).toBe('0: 0 fg:primary; 1 fg:error; 2 bg:diffAddedBg')
  })
})

describe('frame grids', () => {
  it('record where pi-tui would place the hardware cursor', async () => {
    expect((await frameGrid(['', `ab${CURSOR_MARKER}c`], 6)).split('\n')[0]).toBe('grid 6x2 cursor 1,2')
  })

  it('fail on a row wider than the frame instead of wrapping it', async () => {
    await expect(frameGrid(['abcdef', 'x'], 4)).rejects.toThrow('wider than 4 columns')
  })
})
