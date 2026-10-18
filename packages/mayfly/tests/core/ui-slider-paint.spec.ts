/** The slider painter's rows: the track, markers, captions, folds, disabled levels, and narrow widths.
 * @module @ephemeral-ai/mayfly/tests/core/ui-slider-paint
 */
import { describe, expect, it } from 'vitest'
import type { MayflySliderLevel, MayflySliderNode } from '@ephemeral-ai/mayfly-ui'
import { paintSlider } from '../../src/core/ui-slider-paint.ts'
import type { UiSliderModel } from '../../src/core/ui-interaction-slider.ts'
import { plain, plainColors } from '../helpers.ts'

function level(id: string, label = id, disabled = false): MayflySliderLevel {
  return { id, label, ...(disabled ? { disabled: true, disabledReason: 'fixed' } : {}) }
}

function slider(over: Partial<MayflySliderNode> = {}): MayflySliderNode {
  return { kind: 'slider', id: 'effort', levels: [level('low', 'Low'), level('mid', 'Mid'), level('high', 'High')], ...over }
}

function tagged(node: MayflySliderNode, width: number, model?: UiSliderModel | undefined): string[] {
  return plain(paintSlider({ node, model, width, colors: plainColors() }))
}

describe('paintSlider: the track and labels', () => {
  it('draws a plain rule with no active level when neither a model nor the node names one', () => {
    const rows = tagged(slider(), 40)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/─{28}/u)
    expect(rows[0]).not.toContain('▲')
    expect(rows[1]).toContain('Low')
    expect(rows[1]).toContain('Mid')
    expect(rows[1]).toContain('High')
  })

  it('follows the inherited level, tags it (default), and places the marker over its label', () => {
    const node = slider({ inheritedId: 'mid', startCaption: 'Faster', endCaption: 'Smarter' })
    const rows = tagged(node, 40)
    // The captions fit, so the three rows are the captions, the rule, and the labels.
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Faster')
    expect(rows[0]).toContain('Smarter')
    expect(rows[1]).toContain('▲')
    expect(rows[2]).toContain('Mid (default)')
    // The active label is strong/primary; its tag is muted, not part of the marker's position.
    expect(rows[1]).toContain('▲')
    expect(rows[2]).toContain('(default)')
  })

  it('draws the model pin over the node seed and keeps the inherited tag on another level', () => {
    const model = { pinned: 'low' } as UiSliderModel
    const rows = tagged(slider({ selectedId: 'high', inheritedId: 'mid' }), 40, model)
    expect(rows[0]).toContain('▲')
    expect(rows.at(-1)).toContain('Mid (default)')
    
    expect(rows[0]).toContain('▲')
  })

  it('falls back to the inherited level when the model has no pin', () => {
    const model = { pinned: null } as UiSliderModel
    const rows = tagged(slider({ selectedId: 'high', inheritedId: 'mid' }), 40, model)
    expect(rows[0]).toContain('▲')
  })

  it('uses the node seed when no surface model is present', () => {
    const rows = tagged(slider({ selectedId: 'high' }), 40)
    expect(rows[0]).toContain('▲')
  })

  it('draws a full muted rule when the active id names no level', () => {
    const model = { pinned: 'gone' } as UiSliderModel
    const rows = tagged(slider(), 40, model)
    expect(rows[0]).not.toContain('▲')
    // The tag is on the inherited level only; a foreign pin leaves every level untagged.
    expect(rows[1]).not.toContain('default')
  })

  it('spreads many labels inside the track, pushing them apart and clamping the last to the end', () => {
    const many = Array.from({ length: 5 }, (_, index) => level(`l${String(index)}`, `L${String(index)}`))
    const rows = tagged(slider({ levels: many, inheritedId: 'l2' }), 34)
    const labels = rows.at(-1)!
    expect(labels).toContain('L0')
    expect(labels).toContain('L4')
    // The rightmost label ends inside the track (its start is clamped, not overflowing).
    expect(labels.trimEnd().endsWith('L4')).toBe(true)
  })

  it('centers a single level and marks it without needing a neighbor', () => {
    const rows = tagged(slider({ levels: [level('only', 'Only')], inheritedId: 'only' }), 30)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('▲')
    expect(rows[1]).toContain('Only (default)')
  })

  it('mutes a disabled level and keeps the active marker off it', () => {
    const node = slider({ levels: [level('low', 'Low'), level('mid', 'Mid', true), level('high', 'High')], inheritedId: 'low' })
    const rows = tagged(node, 40)
    expect(rows[1]).toContain('Mid')
    expect(rows[0]).toContain('▲')
  })

  it('floors and clamps the width to at least one column', () => {
    const rows = paintSlider({ node: slider(), model: undefined, width: 0.5, colors: plainColors() })
    // One folded/clipped row, never an empty or negative repeat.
    expect(rows).toHaveLength(1)
    expect(plain(rows)[0]!.length).toBeLessThanOrEqual(1)
  })
})

describe('paintSlider: captions', () => {
  it('omits the caption row when both captions are absent or empty', () => {
    expect(tagged(slider(), 40)).toHaveLength(2)
    expect(tagged(slider({ startCaption: '', endCaption: '' }), 40)).toHaveLength(2)
  })

  it('draws a one-sided caption when just one end is named', () => {
    const start = tagged(slider({ startCaption: 'Faster' }), 40)
    expect(start).toHaveLength(3)
    expect(start[0]).toContain('Faster')
    const end = tagged(slider({ endCaption: 'Smarter' }), 40)
    expect(end).toHaveLength(3)
    expect(end[0]).toContain('Smarter')
  })

  it('omits captions that would not fit between the track ends', () => {
    const rows = tagged(slider({ startCaption: 'A long start caption', endCaption: 'A long end caption' }), 20)
    expect(rows).toHaveLength(2)
    expect(rows.join('\n')).not.toContain('long start')
  })

  it('clips a caption row that overflows the width', () => {
    const rows = paintSlider({ node: slider({ startCaption: 'x'.repeat(30), endCaption: 'y'.repeat(30) }), model: undefined, width: 10, colors: plainColors() })
    for (const row of plain(rows)) expect(row.length).toBeLessThanOrEqual(10)
  })
})

describe('paintSlider: the narrow fold', () => {
  it('folds to the active level with its tag, neighbors, and a +N count', () => {
    const node = slider({ inheritedId: 'mid' })
    const rows = tagged(node, 20)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('‹')
    expect(rows[0]).toContain('›')
    expect(rows[0]).toContain('Mid')
    expect(rows[0]).toContain('(default)')
    // The far levels do not fit: the rest are counted.
    expect(rows[0]).toMatch(/\+\d/u)
    expect(rows[0]).not.toContain('High')
  })

  it('measures a two-level fold that admits both levels without a hidden count', () => {
    const node = slider({ levels: [level('low', 'Low'), level('high', 'High')], inheritedId: 'high' })
    const rows = tagged(node, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('High')
    // Adding the other level fills the row, so no `+N` is written.
    expect(rows[0]).not.toContain('Low')
    expect(rows[0]).not.toContain('+')
  })

  it('folds a single level with no hidden count and clips it to the width', () => {
    const node = slider({ levels: [level('only', 'A very wide level')] })
    const rows = tagged(node, 4)
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toContain('+')
    expect(rows[0]).toContain('‹')
  })

  it('mutes a disabled level inside the fold and keeps a foreign active id unmarked', () => {
    const node = slider({ levels: [level('low', 'Lowest'), level('mid', 'Middling', true), level('high', 'Highest')] })
    const model = { pinned: 'gone' } as UiSliderModel
    const rows = tagged(node, 22, model)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('Lowest')
    expect(rows[0]).toContain('Middling')
    expect(rows[0]).toContain('+1')
    expect(rows[0]).not.toContain('▲')
  })

  it('spreads all three labels when the width leaves the track intact', () => {
    const node = slider({ inheritedId: 'mid' })
    const rows = tagged(node, 24)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Low')
    expect(rows[1]).toContain('Mid')
    expect(rows[1]).toContain('High')
  })
})
