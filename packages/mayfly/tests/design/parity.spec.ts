/** The parity helper: cell classes, waivers, golden frames, and the real surface driver. */
import { afterEach, describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { DESIGN_DELTAS } from './deltas.ts'
import { PROBE_PALETTE, PROBE_TOKEN_COLORS, compareCells, createRealSurface, parityComponents, parseCells, readGoldenFrames } from './parity.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'

const proto = (text: string, rgb: string, extra = ''): string => `\x1b[${extra}38;2;${rgb}m${text}\x1b[0m`
const PRIMARY = '154;134;230'

describe('probe palette', () => {
  it('paints every semantic color as a distinct color', () => {
    expect(new Set(PROBE_TOKEN_COLORS.values()).size).toBe(PROBE_TOKEN_COLORS.size)
    expect(PROBE_PALETTE.text('x')).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[39m$/u)
  })
})

describe('cell classes', () => {
  it('names the prototype tones and treats a dim cell with no color as muted', async () => {
    const cells = await parseCells([`${proto('a', PRIMARY, '1;')}\x1b[2mb\x1b[0m ${proto('c', '230;110;110')}`], 10, 'prototype')
    expect(cells[0]!.slice(0, 4).map(cell => [cell.ch, cell.tone, cell.bold])).toEqual([['a', 'primary', true], ['b', 'muted', false], [' ', 'default', false], ['c', 'danger', false]])
  })

  it('maps real probe colors to tones and flags tokens that have no prototype tone', async () => {
    const rows = [`${PROBE_PALETTE.primary('p')}${PROBE_PALETTE.error('e')}${PROBE_PALETTE.mdLink('b')}${PROBE_PALETTE.diffAddedBg('g')}${PROBE_PALETTE.borderFocus('f')}${PROBE_PALETTE.textMuted('m')}`]
    const cells = (await parseCells(rows, 8, 'real'))[0]!
    expect(cells.slice(0, 6).map(cell => cell.tone)).toEqual(['primary', 'danger', 'token:mdLink', 'default', 'primary', 'muted'])
    expect(cells[3]!.bg).toBe('diffAddedBg')
  })

  it('reads weight, inverse, strike, and unmapped colors', async () => {
    const [row] = await parseCells(['\x1b[7mi\x1b[0m\x1b[9ms\x1b[0m\x1b[3mt\x1b[0m\x1b[38;2;1;2;3mz\x1b[0m\x1b[48;2;4;5;6mq\x1b[0m'], 6, 'prototype')
    expect(row!.slice(0, 5).map(cell => [cell.inverse, cell.strike, cell.italic, cell.tone, cell.bg])).toEqual([
      [true, false, false, 'default', 'none'], [false, true, false, 'default', 'none'], [false, false, true, 'default', 'none'],
      [false, false, false, 'rgb:1,2,3', 'none'], [false, false, false, 'default', 'rgb:4,5,6'],
    ])
  })
})

describe('compareCells', () => {
  it('matches the prototype and the real renderer when both paint the same tone', async () => {
    const expected = await parseCells([`${proto('ok', PRIMARY)}   `], 8, 'prototype')
    const actual = await parseCells([PROBE_PALETTE.primary('ok')], 8, 'real')
    expect(compareCells(expected, actual)).toEqual([])
  })

  it('reports the cell, its class, and rows that exist on one side only', async () => {
    const expected = await parseCells([proto('ab', PRIMARY), 'x'], 4, 'prototype')
    const actual = await parseCells([`${PROBE_PALETTE.primary('a')}${PROBE_PALETTE.error('b')}`], 4, 'real')
    expect(compareCells(expected, actual)).toEqual([
      { row: 0, col: 1, expected: '"b" primary', actual: '"b" danger' },
      { row: 1, col: 0, expected: '"x" default', actual: '(none)' },
    ])
  })

  it('waives cells only under an accepted difference', async () => {
    const expected = await parseCells(['abc'], 4, 'prototype')
    const actual = await parseCells(['abd'], 4, 'real')
    expect(compareCells(expected, actual, [{ delta: 'Δ17', rows: [0, 0], cols: [2, 3] }])).toEqual([])
    expect(compareCells(expected, actual, [{ delta: 'Δ17', cols: [0, 1] }])).toHaveLength(1)
    expect(() => compareCells(expected, actual, [{ delta: 'Δ99' }])).toThrow('unknown accepted difference Δ99')
    expect(new Set(DESIGN_DELTAS.map(delta => delta.id)).size).toBe(25)
  })
})

describe('golden frames', () => {
  it('reads one frame per step and parses it into cells', async () => {
    const frames = readGoldenFrames('03-fields-and-forms', 'move')
    expect(frames.map(frame => frame.label)).toEqual(['start', '"\\u001b[B"', '"\\u001b[B"', '"\\u001b[B"', '"\\u001b[B"', '"\\u001b[B"', '"\\u001b[B"'])
    const cells = await parseCells(frames[0]!.rows, 96, 'prototype')
    expect(cells[0]![0]).toMatchObject({ ch: '╭', tone: 'primary' })
    expect(walks().filter(walk => walk.scene === 3).map(walk => walk.name)).toContain('move')
  })

  it('reads a step that painted nothing as no rows', () => {
    expect(readGoldenFrames('03-fields-and-forms', 'initial')).toHaveLength(1)
  })
})

describe('real surface', () => {
  const surfaces: ReturnType<typeof createRealSurface>[] = []
  afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

  it('renders under the probe palette and moves the cursor with a key', async () => {
    const node = ui.list({ id: 'people', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] })
    const surface = createRealSurface(node, 40, { components: parityComponents() })
    surfaces.push(surface)
    const before = surface.render()
    const after = surface.press('\x1b[B')
    expect(before.join('\n')).toContain('Alpha')
    expect(after).not.toEqual(before)
    const cells = await parseCells(after, 40, 'real')
    expect(cells.flat().some(cell => cell.tone === 'token:selectedBg' || cell.bg === 'selectedBg' || cell.tone !== 'default')).toBe(true)
  })
})
