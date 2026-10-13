/**
 * A tolerant reader of the string fields of a JSON object that is still being generated: a tool call's arguments arrive
 * as deltas, and the text of a `write` or an `edit` is readable long before the object closes. Pure.
 *
 * @module @ephemeral-ai/mayfly/transcript/partial-json
 */

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }

interface Scanned {
  readonly value: string
  /** The index after the closing quote, or after the cut when the string is still open. */
  readonly end: number
  readonly closed: boolean
}

/** Read the string starting at the quote `from`, decoding its escapes; an escape cut by the end of the text is dropped. */
function scanString(text: string, from: number): Scanned {
  let value = ''
  let index = from + 1
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') return { value, end: index + 1, closed: true }
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6)
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) break
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
      continue
    }
    value += SIMPLE_ESCAPES[next] ?? next
    index += 2
  }
  return { value, end: text.length, closed: false }
}

/** The index after the value at `from` that is not a string (a number, a literal, an object, an array), or the end of the text. */
function skipValue(text: string, from: number): number {
  let depth = 0
  let index = from
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      const scanned = scanString(text, index)
      if (!scanned.closed) return text.length
      index = scanned.end
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      if (depth === 0) return index
      depth -= 1
    } else if (char === ',' && depth === 0) return index
    index += 1
  }
  return text.length
}

/**
 * The string fields of a possibly truncated JSON object, in the order they were written. A string cut by the end of
 * the text is returned as far as it goes; a field that is not a string is skipped.
 * @param text - the arguments received so far.
 * @returns each string field's decoded text, and the key of the one still being written, if any.
 */
export function partialStrings(text: string): { readonly fields: Readonly<Record<string, string>>, readonly open?: string } {
  const fields: Record<string, string> = {}
  let index = text.indexOf('{')
  if (index === -1) return { fields }
  index += 1
  while (index < text.length) {
    while (index < text.length && /[\s,]/u.test(text[index]!)) index += 1
    if (text[index] !== '"') break
    const key = scanString(text, index)
    if (!key.closed) break
    index = key.end
    while (index < text.length && /\s/u.test(text[index]!)) index += 1
    if (text[index] !== ':') break
    index += 1
    while (index < text.length && /\s/u.test(text[index]!)) index += 1
    if (index >= text.length) break
    if (text[index] === '"') {
      const value = scanString(text, index)
      fields[key.value] = value.value
      if (!value.closed) return { fields, open: key.value }
      index = value.end
    } else {
      index = skipValue(text, index)
    }
  }
  return { fields }
}
