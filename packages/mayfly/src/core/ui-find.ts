/**
 * Find-in-view painting: where a pattern matches in the text a row painted, the match is drawn in reverse video. It works
 * on the painted line, so one rule covers a label, a Markdown answer, highlighted code, and a diff, whatever styles lie
 * between the letters. A match ends with its line: a pattern a wrap cut in two is not found.
 * @module
 */
import type { MayflyListHighlight } from '@ephemeral-ai/mayfly-ui'

const REVERSE_ON = '\x1b[7m'
const REVERSE_OFF = '\x1b[27m'
/** The match the cursor stands on: reversed, bold, and underlined, so it reads apart from the others. */
const CURRENT_ON = '\x1b[7m\x1b[1m\x1b[4m'
const CURRENT_OFF = '\x1b[24m\x1b[22m\x1b[27m'

/**
 * The pattern of a list's `highlight` as a global regular expression.
 * @param highlight - the list's field.
 * @returns the expression, or `undefined` when the pattern is empty or does not compile.
 */
export function highlightPattern(highlight: MayflyListHighlight | undefined): RegExp | undefined {
  if (highlight === undefined || highlight.pattern === '') return undefined
  try {
    return new RegExp(highlight.pattern, highlight.caseSensitive === true ? 'gu' : 'giu')
  } catch {
    return undefined
  }
}

/** The length of the escape sequence that starts at `at`, or `0` when the character there is plain text. */
function escapeLength(line: string, at: number): number {
  if (line.charCodeAt(at) !== 0x1b) return 0
  const kind = line[at + 1]
  if (kind === '[') {
    let end = at + 2
    while (end < line.length && !/[\x40-\x7e]/.test(line[end]!)) end += 1
    return Math.min(line.length, end + 1) - at
  }
  // An OSC (a link) or an APC (the cursor marker) ends at a bell or at `ESC \`.
  if (kind === ']' || kind === '_') {
    let end = at + 2
    while (end < line.length && line[end] !== '\x07' && !(line[end] === '\x1b' && line[end + 1] === '\\')) end += 1
    return Math.min(line.length, end + (line[end] === '\x07' ? 1 : 2)) - at
  }
  return Math.min(2, line.length - at)
}

/** The visible text of a painted line, and where each of its units sits in the line. */
function plainOf(line: string): { readonly plain: string, readonly at: readonly number[] } {
  let plain = ''
  const at: number[] = []
  for (let index = 0; index < line.length;) {
    const skip = escapeLength(line, index)
    if (skip > 0) {
      index += skip
      continue
    }
    plain += line[index]!
    at.push(index)
    index += 1
  }
  return { plain, at }
}

/** The matches of `find` in a text that mark something: those with a width. */
function matchesOf(find: RegExp, plain: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = []
  find.lastIndex = 0
  for (let match = find.exec(plain); match !== null; match = find.exec(plain)) {
    // A match with no width (`a*` between letters) marks nothing; the search steps past it.
    if (match[0].length === 0) find.lastIndex += 1
    else found.push(match)
  }
  return found
}

/**
 * How many matches a painted line holds.
 * @param line - one painted row.
 * @param find - a global expression from {@link highlightPattern}.
 */
export function countMatches(line: string, find: RegExp): number {
  return matchesOf(find, plainOf(line).plain).length
}

/**
 * The line with every match of `find` in reverse video.
 * @param line - one painted row.
 * @param find - a global expression from {@link highlightPattern}.
 * @param current - the index, among the line's matches, of the one the cursor stands on: it is drawn stronger.
 * @returns the same line when nothing matches.
 */
export function highlightLine(line: string, find: RegExp, current?: number): string {
  const { plain, at } = plainOf(line)
  const matches = matchesOf(find, plain)
  if (matches.length === 0) return line
  let out = ''
  let copied = 0
  matches.forEach((match, number) => {
    const start = at[match.index]!
    const end = at[match.index + match[0].length - 1]! + 1
    const on = number === current ? CURRENT_ON : REVERSE_ON
    out += line.slice(copied, start) + on
    // A style set inside the match (`ESC[0m`, bold off) would end the reverse video: it is set again after each one.
    let cursor = start
    while (cursor < end) {
      const skip = escapeLength(line, cursor)
      if (skip > 0) {
        const sequence = line.slice(cursor, cursor + skip)
        out += sequence + (sequence.endsWith('m') ? on : '')
        cursor += skip
      } else {
        out += line[cursor]!
        cursor += 1
      }
    }
    out += number === current ? CURRENT_OFF : REVERSE_OFF
    copied = end
  })
  return out + line.slice(copied)
}
