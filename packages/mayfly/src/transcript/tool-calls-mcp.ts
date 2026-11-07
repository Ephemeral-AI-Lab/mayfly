/**
 * What a call to an MCP tool says, read from what the Harness keeps of it. The Harness has the tool's identity only as its
 * public name, and flattens a result to text (`structuredContent` does not reach the stream), so these read the name for
 * display and the text as JSON when it is. Nothing here decides anything but how a call reads. Pure.
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-calls-mcp
 */

import { partialStrings } from './partial-json.ts'
import { ellipsize } from './present.ts'

/** Scalar arguments a line shows. */
const LINE_ARGUMENTS = 3

/** Characters of the arguments on a line, the separators included; the line's target gives way further when it must. */
const LINE_CHARS = 60

/** Characters of one argument's value on the row under a line. */
const ROW_VALUE_CHARS = 30

/** The hash the Harness appends to a public name it had to change to fit the provider's rules. */
const IDENTITY_HASH = /_[0-9a-f]{12}$/u

/**
 * A public MCP tool name as a person reads it: `mcp__github__get_issue` is `get_issue` on `github`. A name the Harness had to
 * cut may have lost the separator, and then only the part it kept can be named. Display only: the name is never sent back.
 * @param name - the public name, starting `mcp__`.
 * @returns the tool, and its server when the name still says.
 */
export function mcpNameOf(name: string): { readonly server?: string, readonly tool: string } {
  const rest = name.slice('mcp__'.length).replace(IDENTITY_HASH, '')
  const separator = rest.indexOf('__')
  return separator <= 0 || separator + 2 === rest.length ? { tool: rest } : { server: rest.slice(0, separator), tool: rest.slice(separator + 2) }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value)

const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/** A string needs its quotes only when it could not be told from what surrounds it. */
function quoted(text: string): string {
  return /^[^\s,="]+$/u.test(text) ? text : JSON.stringify(text)
}

/** One value of an argument, within `chars`: a string by its text, anything else as its JSON. */
function valueText(value: unknown, chars: number): string {
  return typeof value === 'string' ? quoted(ellipsize(oneLine(value), chars)) : ellipsize(JSON.stringify(value), chars)
}

/**
 * What a call was given, for its line and the row under it. A lone scalar reads as its value; otherwise the line takes up to
 * {@link LINE_ARGUMENTS} scalars as `key=value` within {@link LINE_CHARS} and counts what is left, which the row then lists.
 * Arguments that still stream read as far as their strings have gone.
 * @param text - the call's arguments, as JSON.
 * @returns the line's target and the row, each when there is something to say.
 */
export function mcpArguments(text: string): { readonly target?: string, readonly args?: string } {
  const whole = parsed(text)
  const record = isRecord(whole) ? whole : partialStrings(text).fields
  const entries = Object.entries(record)
  if (entries.length === 0) return {}
  if (entries.length === 1 && isScalar(entries[0]![1])) {
    const value = entries[0]![1]
    return { target: typeof value === 'string' ? ellipsize(oneLine(value), LINE_CHARS) : String(value) }
  }
  const shown: string[] = []
  const left: (readonly [string, unknown])[] = []
  let used = 0
  for (const [key, value] of entries) {
    // The first argument always has its place, cut to fit; the others take theirs whole or wait for the row.
    const pair = !isScalar(value) || shown.length === LINE_ARGUMENTS ? undefined : `${key}=${valueText(value, Math.max(1, LINE_CHARS - key.length - 3))}`
    if (pair === undefined || (shown.length > 0 && used + pair.length + 2 > LINE_CHARS)) left.push([key, value])
    else {
      shown.push(pair)
      used += pair.length + 2
    }
  }
  const target = [...shown, ...left.length === 0 ? [] : [`+${String(left.length)}`]].join(', ')
  return { target, ...left.length === 0 ? {} : { args: left.map(([key, value]) => `${key}=${valueText(value, ROW_VALUE_CHARS)}`).join(' · ') } }
}

/** A value inside a result, on one row: a list of scalars by its items, and anything else that nests as its JSON. */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return oneLine(value)
  if (Array.isArray(value) && value.every(isScalar)) return value.join(', ')
  return JSON.stringify(value)
}

/** A list's item on one row: an object by its values, in the server's order. */
function itemText(item: unknown): string {
  return isRecord(item) ? Object.values(item).map(fieldText).join(' · ') : fieldText(item)
}

/**
 * A result that is JSON, as rows to read: a list has a row per item, and an object a row per field. A server's other text
 * stays as it is.
 * @param text - the result's text.
 * @returns the rows, and how many items a list holds; `undefined` when the text is not a JSON list or object.
 */
export function mcpResultRows(text: string): { readonly lines: readonly string[], readonly items?: number } | undefined {
  const value = parsed(text)
  if (Array.isArray(value)) return { lines: value.map(itemText), items: value.length }
  return isRecord(value) ? { lines: Object.entries(value).map(([key, field]) => `${key}: ${fieldText(field)}`) } : undefined
}
