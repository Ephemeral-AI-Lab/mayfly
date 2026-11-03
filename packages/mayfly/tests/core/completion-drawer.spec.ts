/**
 * Decisions of the completion palette: the rows over the stream at the frame's width, the window that keeps the focused
 * row in view, the problem and wait lines, the file rows, and the overlay's open state.
 * @module @ephemeral-ai/mayfly/tests/core/completion-drawer
 */
import { describe, expect, it } from 'vitest'
import { CompletionDrawer, DRAWER_ROWS, paintDrawer, type DrawerPaint } from '../../src/core/completion-drawer.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'
import { plainColors } from '../helpers.ts'

const components = { visibleWidth, truncateToWidth } as never
const colors = plainColors()
const commands = (count: number, index = 0) => ({
  kind: 'commands' as const,
  prefix: '/m',
  index,
  items: Array.from({ length: count }, (_, i) => ({ label: `/mod${String(i)}`, value: `/mod${String(i)}`, detail: `describe ${String(i)}` })),
})
const paint = (over: Partial<DrawerPaint>): DrawerPaint => ({
  view: commands(3),
  width: 60,
  colors,
  components,
  glyphs: undefined,
  wait: undefined,
  ...over,
})
const plain = (rows: string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))

describe('paintDrawer', () => {
  it('draws one row per item at the frame width, the focused row marked with an arrow', () => {
    const rows = plain(paintDrawer(paint({ view: commands(3, 1) })))
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(visibleWidth(row)).toBe(60)
    expect(rows[0]).toMatch(/^ {2}  \/mod0 /u)
    expect(rows[1]).toMatch(/^ {2}→ \/mod1 /u)
  })

  it('shows a window of the list that keeps the focused row in view', () => {
    const rows = plain(paintDrawer(paint({ view: commands(9, 8) })))
    expect(rows).toHaveLength(DRAWER_ROWS)
    expect(rows.at(-1)).toContain('/mod8')
    expect(rows[0]).toContain('/mod3')
  })

  it('draws a problem mark on the row, and the reason under the focused row', () => {
    const view = { ...commands(2), items: [{ label: '/bad', value: '/bad', problem: 'the source timed out' }, { label: '/ok', value: '/ok' }] }
    const rows = plain(paintDrawer(paint({ view })))
    expect(rows[0]).toContain('!')
    expect(rows[1]).toContain('the source timed out')
    expect(rows).toHaveLength(3)
  })

  it('gives the last row to the wait, and takes its place out of the list', () => {
    const rows = plain(paintDrawer(paint({ view: commands(9, 0), wait: 'Waiting for wiki…' })))
    expect(rows).toHaveLength(DRAWER_ROWS)
    expect(rows.at(-1)).toContain('Waiting for wiki…')
  })

  it('shows a source tag at the right edge of an extension row, cut when long', () => {
    const view = { ...commands(1), items: [{ label: '/ext', value: '/ext', source: 'an-extension-with-a-long-id' }] }
    const [row] = plain(paintDrawer(paint({ view })))
    expect(row).toContain('an-extension-wi…')
    expect(visibleWidth(row!)).toBe(60)
  })

  it('collapses a multi-line description into one muted line', () => {
    const view = { ...commands(1), items: [{ label: '/x', value: '/x', detail: 'first\nsecond  ' }] }
    const [row] = plain(paintDrawer(paint({ view })))
    expect(row).toContain('first second')
  })

  it('marks the typed prefix of a name and keeps the focused name bold', () => {
    const [unfocused, focused] = paintDrawer(paint({ view: commands(2, 1), colors: { ...colors, text: (t: string) => `[${t}]` } as never }))
    expect(unfocused).toContain('[/m]')
    expect(focused).toContain('\x1b[1m')
  })

  it('draws every row inside a narrow frame', () => {
    for (const width of [8, 12, 20]) {
      for (const row of paintDrawer(paint({ view: commands(3, 2), width }))) expect(visibleWidth(row)).toBe(width)
    }
  })

  it('draws a file list: the whole path on each row, the open cue on the focused file only', () => {
    const view = {
      kind: 'files' as const,
      prefix: '@',
      index: 0,
      items: [
        { label: 'src/core/ui-prompt.ts', value: '@src/core/ui-prompt.ts' },
        { label: 'src/core/', value: '@src/core/' },
      ],
    }
    const [file, folder] = plain(paintDrawer(paint({ view, width: 60 })))
    expect(file).toContain('src/core/ui-prompt.ts')
    expect(file).toContain('↗ Ctrl+G')
    expect(folder).not.toContain('↗ Ctrl+G')
  })

  it('cuts a long path at its left so the end that names the file stays', () => {
    const label = `packages/mayfly/src/${'deep/'.repeat(8)}ui-prompt.ts`
    const view = { kind: 'files' as const, prefix: '@', index: 1, items: [{ label: 'a.ts', value: '@a.ts' }, { label, value: `@${label}` }] }
    const [, file] = plain(paintDrawer(paint({ view, width: 40 })))
    expect(file).toContain('…')
    expect(file).toContain('ui-prompt.ts')
    expect(visibleWidth(file!)).toBe(40)
  })

  it('uses the glyph table when the terminal is ASCII', () => {
    const [focused] = paintDrawer(paint({ view: commands(1), glyphs: 'ascii' }))
    expect(focused).toContain('>')
    expect(focused).not.toContain('→')
  })
})

describe('CompletionDrawer', () => {
  const drawer = (view: unknown, wait?: string) => new CompletionDrawer({
    view: () => view as never,
    frameWidth: () => 50,
    colors,
    components,
    glyphs: undefined,
    wait: () => wait,
  })

  it('is closed with no list or an empty one, and paints nothing', () => {
    expect(drawer(undefined).open).toBe(false)
    expect(drawer(commands(0)).open).toBe(false)
    expect(drawer(undefined).render(50)).toEqual([])
    expect(drawer(undefined).rows).toBe(0)
  })

  it('reports the frame width, its rows, and paints at the width it is given', () => {
    const palette = drawer(commands(3))
    expect(palette.width).toBe(50)
    expect(palette.open).toBe(true)
    expect(palette.rows).toBe(3)
    expect(plain(palette.render(30))[0]).toHaveLength(30)
    expect(palette.invalidate()).toBeUndefined()
  })

  it('counts the wait line in its rows', () => {
    expect(drawer(commands(9), 'Waiting…').rows).toBe(DRAWER_ROWS)
    expect(drawer(commands(2), 'Waiting…').rows).toBe(3)
  })

  it('counts a problem line under the focused row', () => {
    const view = { ...commands(2), items: [{ label: '/bad', value: '/bad', problem: 'nope' }, { label: '/ok', value: '/ok' }] }
    expect(drawer(view).rows).toBe(3)
  })
})
