/** Priority admission of a stack row: the ladder, the bands, and the widths of the rows it paints. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { ADMISSION_MIN_TRUNCATED, AdmissionRow, admitWidths, layoutBands } from '../../src/core/ui-admission.ts'
import { compileMayflyStatusNode, compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL } from './width-scan.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { plainColors } from '../helpers.ts'

const colors = plainColors()
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents

describe('admitWidths', () => {
  const entries = [
    { priority: 0, natural: 10 },
    { priority: 1, natural: 6 },
    { priority: 2, natural: 20, overflow: 'hide' as const },
    { priority: 3, natural: 30, overflow: 'truncate' as const },
    { priority: 4, natural: 4 },
  ]

  it('admits in priority order while the gaps and widths fit', () => {
    expect([...admitWidths(entries, 200, 2)]).toEqual([[0, 10], [1, 6], [2, 20], [3, 30], [4, 4]])
    expect([...admitWidths(entries, 18, 2).keys()]).toEqual([0, 1])
  })

  it('lets a hidden child drop while later children may still fit, and a truncated child fill the row', () => {
    const hidden = [{ priority: 0, natural: 10 }, { priority: 1, natural: 30, overflow: 'hide' as const }, { priority: 2, natural: 4 }]
    expect([...admitWidths(hidden, 20, 2)]).toEqual([[0, 10], [2, 4]])
    expect([...admitWidths(entries, 52, 2)]).toEqual([[0, 10], [1, 6], [2, 20], [3, 10]])
  })

  it('ends admission at a child with no overflow that does not fit', () => {
    const plain = [{ priority: 0, natural: 10 }, { priority: 1, natural: 30 }, { priority: 2, natural: 2 }]
    expect([...admitWidths(plain, 20, 2).keys()]).toEqual([0])
  })

  it('does not truncate into less than the minimum room', () => {
    const squeezed = [{ priority: 0, natural: 10 }, { priority: 1, natural: 30, overflow: 'truncate' as const }]
    expect([...admitWidths(squeezed, 10 + 2 + ADMISSION_MIN_TRUNCATED - 1, 2).keys()]).toEqual([0])
    expect([...admitWidths(squeezed, 10 + 2 + ADMISSION_MIN_TRUNCATED, 2)]).toEqual([[0, 10], [1, ADMISSION_MIN_TRUNCATED]])
  })

  it('always admits a child without a priority, and orders ties by position', () => {
    const mixed = [{ priority: 1, natural: 5 }, { natural: 7 }, { priority: 1, natural: 5 }]
    expect([...admitWidths(mixed, 15, 1)]).toEqual([[1, 7], [0, 5]])
  })
})

describe('layoutBands', () => {
  const lay = (left: string, center: string, right: string, width: number) => layoutBands({ left, center, right }, width, 2, components)

  it('puts the left cluster first and the right cluster at the edge', () => {
    expect(lay('ab', '', 'yz', 10)).toBe('ab      yz')
    expect(lay('ab', '', '', 10)).toBe('ab')
    expect(lay('', '', 'yz', 6)).toBe('    yz')
    expect(lay('abcd', '', 'wxyz', 9)).toBe('abcd  wxyz')
    // A right cluster that fills the row sits at its edge: the gap parts it from a left cluster only, never pushes it past the end.
    expect(lay('', '', 'abcdef', 6)).toBe('abcdef')
    expect(lay('', '', 'abcdef', 8)).toBe('  abcdef')
    expect(lay('ab', '', 'cdef', 6)).toBe('ab  cdef')
  })

  it('centers the middle cluster between its neighbours and gives way to them', () => {
    expect(lay('ab', 'MID', 'yz', 20)).toBe('ab      MID       yz')
    expect(lay('abcdefgh', 'MID', 'yz', 20)).toBe('abcdefgh  MID     yz')
    expect(lay('abcdefgh', 'MIDDLE', 'wxyzwxyz', 20)).toBe('abcdefgh  MIDDLEwxyzwxyz')
    expect(lay('', 'MID', '', 11)).toBe('    MID')
    expect(lay('ab', 'MID', '', 11)).toBe('ab  MID')
  })
})

describe('AdmissionRow', () => {
  function row(width: number, node = ui.stack.row([
    ui.child(ui.richText([{ text: 'model' }]), { priority: 0 }),
    ui.child(ui.richText([{ text: 'cache 34%' }]), { priority: 2, band: 'right', overflow: 'hide' }),
    ui.child(ui.richText([{ text: '~/work/mayfly/packages/mayfly' }]), { priority: 1, overflow: 'truncate' }),
  ])) {
    const result = compileMayflyUiNode(node, { emit: () => {}, components, colors, getViewport: () => ({ columns: width, rows: 20 }), screenMode: 'alternate' })
    if (!result.ok) throw new Error(result.message)
    return result.value.component.render(width).map(painted => painted.replaceAll('\x1b[0m', ''))
  }

  it('paints one row, admits what fits, and truncates the child that asks to', () => {
    expect(row(60)).toEqual([`model  ~/work/mayfly/packages/mayfly${' '.repeat(60 - 'model  ~/work/mayfly/packages/mayfly'.length - 'cache 34%'.length)}cache 34%`])
    expect(row(36)).toEqual(['model  ~/work/mayfly/packages/mayfly'])
    expect(row(20)).toEqual(['model  ~/work/mayfly'])
    expect(row(10)).toEqual(['model'])
  })

  it('keeps only the children visible at the viewport', () => {
    const node = ui.stack.row([
      ui.child(ui.richText([{ text: 'wide' }]), { priority: 0, when: { minWidth: 50 } }),
      ui.child(ui.richText([{ text: 'narrow' }]), { priority: 1, when: { maxWidth: 49 } }),
    ])
    expect(row(60, node)).toEqual(['wide'])
    expect(row(40, node)).toEqual(['narrow'])
  })

  it('counts the one row it paints, and a status stack admits the same way', () => {
    const counters = createWorkCounters()
    const result = compileMayflyStatusNode(ui.stack.row([ui.child(ui.richText([{ text: 'a' }]), { priority: 0 }), ui.child(ui.richText([{ text: 'b' }]), { priority: 1, band: 'right' })]), { components, colors, getViewport: () => ({ columns: 10, rows: 3 }), screenMode: 'main', counters })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.component.render(10).map(painted => painted.replaceAll('\x1b[0m', ''))).toEqual(['a        b'])
    expect(counters.rowsPainted).toBeGreaterThanOrEqual(1)
    const direct = new AdmissionRow({ components, colors, children: () => [] })
    expect(direct.render(5)).toEqual([''])
    const silent = new AdmissionRow({ components, colors, children: () => [{ forms: [{ rank: -1, component: { render: () => [], invalidate: () => {} } }], band: 'left' }] })
    expect(silent.render(5).map(painted => painted.replaceAll('\x1b[0m', ''))).toEqual([''])
    direct.invalidate()
  })

  describe('shedding and the underline mark', () => {
    const words = (text: string) => ui.richText([{ text }])
    /** Three shed nodes: a time that goes first, a git fact next, and a model that goes last. */
    const shedRow = (width: number, extra: readonly ReturnType<typeof ui.child>[] = []) => row(width, ui.stack.row([
      ui.child(ui.shed(words('model High'), [{ rank: 70, node: words('model') }]), { priority: 0 }),
      ui.child(ui.shed(words('● jobs 2 41s'), [{ rank: 5, node: words('● jobs 2') }]), { priority: 12 }),
      ui.child(ui.shed(words('main*↑2'), [{ rank: 30, node: null }]), { priority: 10 }),
      ...extra,
    ]))

    it('gives up the narrower forms in rank order, across every child, until the row fits', () => {
      expect(shedRow(60)).toEqual(['model High  ● jobs 2 41s  main*↑2'])
      // 32 columns: the time (rank 5) goes first.
      expect(shedRow(32)).toEqual(['model High  ● jobs 2  main*↑2'])
      // 20: then git (rank 30) is hidden; the model keeps its effort until its own rank (70).
      expect(shedRow(20)).toEqual(['model High  ● jobs 2'])
      expect(shedRow(16)).toEqual(['model  ● jobs 2'])
      // Where even the thinnest forms do not fit, admission drops what ranks last in priority.
      expect(shedRow(12)).toEqual(['model'])
    })

    it('paints a heavy line under the words of a marked child on the row below, and nowhere else', () => {
      const marked = ui.stack.row([
        ui.child(words('model'), { priority: 0 }),
        ui.child(words('● jobs 2'), { priority: 1, mark: 'underline' }),
        ui.child(words('● goal'), { priority: 2 }),
      ])
      expect(row(40, marked)).toEqual(['model  ● jobs 2  ● goal', `       ${'━'.repeat('● jobs 2'.length)}`])
      // The mark follows its child when the row sheds and when the child sits in the right band.
      const right = ui.stack.row([ui.child(words('model'), { priority: 0 }), ui.child(words('ctx 18%'), { priority: 1, band: 'right', mark: 'underline' })])
      const [line, underline] = row(20, right)
      expect(line).toBe(`model${' '.repeat(8)}ctx 18%`)
      expect(underline).toBe(`${' '.repeat(13)}${'━'.repeat(7)}`)
    })

    it('puts the heavy line under a marked child that has no right neighbour', () => {
      const [line, underline] = row(30, ui.stack.row([ui.child(words('lonely'), { priority: 0, mark: 'underline' })]))
      expect(line).toBe('lonely')
      expect(underline).toBe('━'.repeat(6))
    })

    it('puts the heavy line under a lone center child, and under one with only a left or only a right neighbour', () => {
      const alone = ui.stack.row([ui.child(words('MID'), { priority: 0, band: 'center', mark: 'underline' })])
      const [line, underline] = row(21, alone)
      expect(line!.trim()).toBe('MID')
      expect(underline!.indexOf('━')).toBe(line!.indexOf('MID'))
      const withLeft = ui.stack.row([ui.child(words('left'), { priority: 0 }), ui.child(words('MID'), { priority: 1, band: 'center', mark: 'underline' })])
      expect(row(21, withLeft)[1]!.indexOf('━')).toBe(row(21, withLeft)[0]!.indexOf('MID'))
      const withRight = ui.stack.row([ui.child(words('MID'), { priority: 0, band: 'center', mark: 'underline' }), ui.child(words('right'), { priority: 1, band: 'right' })])
      expect(row(21, withRight)[1]!.indexOf('━')).toBe(row(21, withRight)[0]!.indexOf('MID'))
    })

    it('puts the heavy line under a marked child in the center band, and a shed node of equal rank gives up in order of position', () => {
      const center = ui.stack.row([
        ui.child(words('left'), { priority: 0 }),
        ui.child(words('MID'), { priority: 1, band: 'center', mark: 'underline' }),
        ui.child(words('right'), { priority: 2, band: 'right' }),
      ])
      const [line, underline] = row(30, center)
      expect(line!.indexOf('MID')).toBe(Math.floor((30 - 3) / 2))
      expect(underline!.indexOf('━')).toBe(line!.indexOf('MID'))
      expect(underline!.trimEnd().length - underline!.indexOf('━')).toBe(3)
      // Two nodes shed at the same rank: the earlier one goes first, and the row stops shedding as soon as it fits.
      const tie = (width: number) => row(width, ui.stack.row([
        ui.child(ui.shed(words('aaaa aaaa'), [{ rank: 5, node: words('aaaa') }]), { priority: 0 }),
        ui.child(ui.shed(words('bbbb bbbb'), [{ rank: 5, node: words('bbbb') }]), { priority: 1 }),
      ]))
      expect(tie(30)).toEqual(['aaaa aaaa  bbbb bbbb'])
      expect(tie(18)).toEqual(['aaaa  bbbb bbbb'])
      expect(tie(10)).toEqual(['aaaa  bbbb'])
    })
  })

  it.each(ADVERSARIAL)('never exceeds its width over $name, from 24 to 140 columns', ({ text }) => {
    const node = ui.stack.row([
      ui.child(ui.richText([{ text: 'model High' }]), { priority: 0 }),
      ui.child(ui.richText([{ text: 'PLAN', styles: ['strong'] }]), { priority: 1 }),
      ui.child(ui.richText([{ text }]), { priority: 5, overflow: 'truncate' }),
      ui.child(ui.richText([{ text, tone: 'muted' }]), { priority: 4, band: 'right', overflow: 'hide' }),
      ui.child(ui.richText([{ text: text.slice(0, 12) }]), { priority: 6, band: 'center' }),
      ui.child(ui.richText([{ text: 'git' }]), { priority: 10 }),
    ], { gap: 2 })
    for (let width = 24; width <= 140; width += 1) {
      const rows = row(width, node)
      expect(rows).toHaveLength(1)
      expect(visibleWidth(rows[0]!), `width ${String(width)}`).toBeLessThanOrEqual(width)
    }
  })
})
