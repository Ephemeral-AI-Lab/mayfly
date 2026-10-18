/** Admission rules for a `slider`: bounded levels, known seeds, and short captions.
 * @module @ephemeral-ai/mayfly/tests/core/ui-validator-slider
 */
import { describe, expect, it } from 'vitest'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { MAYFLY_UI_MAX_SLIDER_LABEL, MAYFLY_UI_MAX_SLIDER_LEVELS } from '../../src/core/ui-validator-slider.ts'

function accepted(value: unknown) {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function rejected(value: unknown): string {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

function slider(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'slider', id: 'effort', levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], ...over }
}

describe('slider level admission', () => {
  it('admits every optional field, including a disabled level with its reason', () => {
    const node = accepted(slider({
      levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', disabled: true, disabledReason: 'Fixed' }],
      selectedId: 'low', inheritedId: 'high', startCaption: 'Faster', endCaption: 'Smarter', hintLabel: 'effort', autofocus: true,
    }))
    expect(node).toMatchObject({
      selectedId: 'low', inheritedId: 'high', startCaption: 'Faster', endCaption: 'Smarter', hintLabel: 'effort', autofocus: true,
      levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', disabled: true, disabledReason: 'Fixed' }],
    })
  })

  it('admits a bare slider and an explicit disabled false', () => {
    expect(accepted(slider({ levels: [{ id: 'only', label: 'Only', disabled: false }] }))).toMatchObject({ levels: [{ disabled: false }] })
    expect(accepted(slider())).toEqual(slider())
  })

  it('requires levels and bounds the level count', () => {
    expect(rejected({ kind: 'slider', id: 'effort' })).toContain('.levels is required')
    expect(rejected(slider({ levels: [] }))).toContain(`1 to ${String(MAYFLY_UI_MAX_SLIDER_LEVELS)} levels`)
    expect(rejected(slider({ levels: Array.from({ length: MAYFLY_UI_MAX_SLIDER_LEVELS + 1 }, (_, index) => ({ id: `l${String(index)}`, label: 'L' })) })))
      .toContain(`1 to ${String(MAYFLY_UI_MAX_SLIDER_LEVELS)} levels`)
  })

  it('rejects a malformed level and duplicate ids', () => {
    expect(rejected(slider({ levels: ['low'] }))).toContain('levels[0]')
    expect(rejected(slider({ levels: [{ label: 'Low' }] }))).toContain('levels[0].id is required')
    expect(rejected(slider({ levels: [{ id: 'low' }] }))).toContain('levels[0].label is required')
    expect(rejected(slider({ levels: [{ id: 'low', label: 'Low', disabled: 'yes' }] }))).toContain('.disabled')
    expect(rejected(slider({ levels: [{ id: 'low', label: 'Low', disabledReason: 2 }] }))).toContain('.disabledReason')
    expect(rejected(slider({ levels: [{ id: 'low', label: 'Low' }, { id: 'low', label: 'Again' }] }))).toContain('duplicate ids')
  })
})

describe('slider field admission', () => {
  it('rejects seeds that name no admitted level', () => {
    expect(rejected(slider({ selectedId: 'gone' }))).toContain('.selectedId must name one of the levels')
    expect(rejected(slider({ inheritedId: 'gone' }))).toContain('.inheritedId must name one of the levels')
    expect(rejected(slider({ selectedId: 1 }))).toContain('.selectedId')
  })

  it('bounds the caption and hint text', () => {
    const long = 'x'.repeat(MAYFLY_UI_MAX_SLIDER_LABEL + 1)
    for (const key of ['startCaption', 'endCaption', 'hintLabel'] as const) {
      expect(rejected(slider({ [key]: long }))).toContain(`at most ${String(MAYFLY_UI_MAX_SLIDER_LABEL)} characters`)
    }
    const atLimit = 'x'.repeat(MAYFLY_UI_MAX_SLIDER_LABEL)
    expect(accepted(slider({ startCaption: atLimit }))).toMatchObject({ startCaption: atLimit })
  })

  it('rejects non-boolean autofocus and non-string captions', () => {
    expect(rejected(slider({ autofocus: 1 }))).toContain('.autofocus')
    expect(rejected(slider({ endCaption: 4 }))).toContain('endCaption')
  })
})
