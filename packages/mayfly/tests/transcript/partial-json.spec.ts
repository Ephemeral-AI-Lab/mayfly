/**
 * Decision tests of the tolerant string reader for a tool call's arguments while they are still being generated:
 * escapes, a string cut mid-way, skipped non-string values, and text that is not an object.
 * @module transcript-partial-json
 */

import { describe, expect, it } from 'vitest'
import { partialStrings } from '../../src/transcript/partial-json.ts'

describe('partialStrings', () => {
  it('reads every string field of a closed object in order', () => {
    const result = partialStrings('{"path": "a.ts", "content" :\n "x\\ny"}')
    expect(result.fields).toEqual({ path: 'a.ts', content: 'x\ny' })
    expect(Object.keys(result.fields)).toEqual(['path', 'content'])
    expect(result.open).toBeUndefined()
  })

  it('returns no fields when there is no object yet', () => {
    expect(partialStrings('')).toEqual({ fields: {} })
    expect(partialStrings('[1, 2]')).toEqual({ fields: {} })
  })

  it('reports the key whose string is still being written', () => {
    expect(partialStrings('{"path": "a.ts", "content": "line one\\nli')).toEqual({
      fields: { path: 'a.ts', content: 'line one\nli' },
      open: 'content',
    })
  })

  it('reports an empty open string right after its quote', () => {
    expect(partialStrings('{"content": "')).toEqual({ fields: { content: '' }, open: 'content' })
  })

  it('decodes the simple escapes and keeps an unknown escape as its character', () => {
    const result = partialStrings('{"s": "\\t\\r\\b\\f\\"\\\\\\/\\q"}')
    expect(result.fields['s']).toBe('\t\r\b\f"\\/q')
  })

  it('decodes unicode escapes', () => {
    expect(partialStrings('{"s": "caf\\u00e9 \\u4F60"}').fields['s']).toBe('café 你')
  })

  it('drops an escape cut by the end of the text', () => {
    expect(partialStrings('{"s": "abc\\')).toEqual({ fields: { s: 'abc' }, open: 's' })
    expect(partialStrings('{"s": "abc\\u00')).toEqual({ fields: { s: 'abc' }, open: 's' })
  })

  it('stops a string at a malformed unicode escape', () => {
    expect(partialStrings('{"s": "ab\\u00zzcd"}')).toEqual({ fields: { s: 'ab' }, open: 's' })
  })

  it('stops before a key that is not yet complete', () => {
    expect(partialStrings('{"path": "a", "con')).toEqual({ fields: { path: 'a' } })
  })

  it('stops at a key that is not a string, a missing colon, or a missing value', () => {
    expect(partialStrings('{path: "a"}')).toEqual({ fields: {} })
    expect(partialStrings('{"path" "a"}')).toEqual({ fields: {} })
    expect(partialStrings('{"path":')).toEqual({ fields: {} })
    expect(partialStrings('{"path":  ')).toEqual({ fields: {} })
  })

  it('skips numbers, literals, objects and arrays and keeps the string fields around them', () => {
    const text = '{"a": 12.5e3, "b": true, "c": null, "d": {"x": "no", "y": [1, {"z": "deep"}]}, "e": [ "q", ["r"] ], "f": "kept"}'
    expect(partialStrings(text)).toEqual({ fields: { f: 'kept' } })
  })

  it('does not split a skipped value at a comma or bracket inside its strings', () => {
    const text = '{"a": ["x,]", "y\\"}"], "b": "after"}'
    expect(partialStrings(text)).toEqual({ fields: { b: 'after' } })
  })

  it('skips a value that is cut before it ends', () => {
    expect(partialStrings('{"s": "ok", "n": 12')).toEqual({ fields: { s: 'ok' } })
    expect(partialStrings('{"s": "ok", "n": [1, {"k": "v"')).toEqual({ fields: { s: 'ok' } })
  })

  it('skips a value whose nested string is cut', () => {
    expect(partialStrings('{"s": "ok", "n": ["abc')).toEqual({ fields: { s: 'ok' } })
  })

  it('stops a skipped scalar at the closing brace of the object', () => {
    expect(partialStrings('{"n": 1} trailing "x": "y"')).toEqual({ fields: {} })
  })

  it('tolerates leading text before the object and trailing commas', () => {
    expect(partialStrings('noise {"a": "1",, "b": "2",')).toEqual({ fields: { a: '1', b: '2' } })
  })
})
