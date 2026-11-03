/** The joined text of a content field (core/field-text.ts): one join per admitted field.
 * @module @ephemeral-ai/mayfly/core/tests/field-text
 */

import { describe, expect, it } from 'vitest'
import { fieldText } from '../../src/core/field-text.ts'

describe('fieldText', () => {
  it('joins a frozen chunk list once, however often and from wherever it is read', () => {
    let reads = 0
    const chunk = (text: string) => Object.freeze({ get text() { reads += 1; return text } })
    const field = Object.freeze([chunk('a\n'), chunk('b')])
    expect(fieldText(field)).toBe('a\nb')
    expect(reads).toBe(2)
    expect(fieldText(field)).toBe('a\nb')
    expect(reads).toBe(2)
    // Another list sharing the chunks is a new identity and joins again.
    expect(fieldText(Object.freeze([...field]))).toBe('a\nb')
    expect(reads).toBe(4)
  })

  it('joins a list that is not frozen every time, since its caller may still change it', () => {
    const chunks = [{ text: 'a' }, { text: 'b' }]
    expect(fieldText(chunks)).toBe('ab')
    chunks.push({ text: 'c' })
    expect(fieldText(chunks)).toBe('abc')
  })

  it('returns a string field as it is', () => {
    expect(fieldText('plain')).toBe('plain')
  })
})
