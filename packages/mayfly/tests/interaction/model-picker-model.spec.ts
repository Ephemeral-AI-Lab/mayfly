/** Native catalog label formatting shared by model picker consumers.
 * @module @ephemeral-ai/mayfly/tests/interaction/model-picker-model
 */
import { expect, it } from 'vitest'
import { formatContextWindow, ModelPicker } from '../../src/components/model-picker.ts'

it.each([[512, '512'], [1024, '1k'], [1536, '1.5k'], [12 * 1024, '12k'], [1024 ** 3, '1g']])('formats %s context tokens as %s', (value, label) => {
  expect(formatContextWindow(Number(value))).toBe(label)
})

it('keeps an unknown or retired native default unselected instead of inventing an inherited effort', () => {
  const node = ModelPicker({
    title: 'Select a model', description: 'Choose the native route', thinking: 'Thinking', empty: 'No models',
    rows: [
      { id: 'unset', label: 'Provider/Unset', group: 'Provider', strip: { efforts: ['low', 'high'] } },
      { id: 'retired', label: 'Provider/Retired', group: 'Provider', strip: { efforts: ['low', 'high'], inherited: 'removed', pinned: 'high' } },
    ],
  })
  if (node.child.kind !== 'list') throw new Error('The model picker must expose its shared list')
  const [unset, retired] = node.child.items
  expect(unset?.segment).toEqual({ label: 'Thinking', options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] })
  expect(retired?.segment).toMatchObject({ selectedId: 'high' })
  expect(retired?.segment).not.toHaveProperty('inheritedId')
})
