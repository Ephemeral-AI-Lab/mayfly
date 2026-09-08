/** Native catalog label formatting shared by model picker consumers.
 * @module @ephemeral-ai/mayfly/tests/interaction/model-picker-model
 */
import { expect, it } from 'vitest'
import { formatContextWindow } from '../../src/interaction/model-picker-model.ts'

it.each([[512, '512'], [1024, '1k'], [1536, '1.5k'], [12 * 1024, '12k'], [1024 ** 3, '1g']])('formats %s context tokens as %s', (value, label) => {
  expect(formatContextWindow(Number(value))).toBe(label)
})
