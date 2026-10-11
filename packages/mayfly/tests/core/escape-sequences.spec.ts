/**
 * The one terminal-escape grammar (`core/escape-sequences.ts`) behind admission (`ui-validator.ts`), paint-time
 * sanitization (`plugin-view.ts`), and the painted-text scanner (`content-rows.ts`): all three agree on every
 * sequence class, visible text between terminated OSC sequences survives, and thousands of unterminated openers
 * cost linear time.
 *
 * @module @ephemeral-ai/mayfly/core/tests/escape-sequences
 */

import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { stripEscapeSequences, stripTerminalText, terminalSequenceAt } from '../../src/core/escape-sequences.ts'
import { sanitizePluginText } from '../../src/core/plugin-view.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

/** What each path must produce: the same text with every sequence and unsafe control gone. */
const CASES: Array<{ readonly name: string, readonly input: string, readonly expected: string }> = [
  { name: 'OSC 8 pair with text between', input: '\x1b]8;;http://x/a\x1b\\label-a\x1b]8;;\x1b\\ and \x1b]8;;http://x/b\x1b\\label-b\x1b]8;;\x1b\\ tail', expected: 'label-a and label-b tail' },
  { name: 'OSC title sequences around text', input: 'one \x1b]0;t1\x1b\\KEEP THIS\x1b]0;t2\x1b\\ two', expected: 'one KEEP THIS two' },
  { name: 'BEL-terminated OSC next to a stray BEL', input: '\x1b]0;t\x1b\\KEEP\x07 rest', expected: 'KEEP rest' },
  { name: 'OSC with BEL terminator', input: 'a\x1b]0;title\x07b', expected: 'ab' },
  { name: 'APC payload', input: 'a\x1b_Gi=1,a=some-data\x1b\\b', expected: 'ab' },
  { name: 'DCS payload', input: 'a\x1bPq1;2;10;0;0\x1b\\b', expected: 'ab' },
  { name: 'SOS and PM payloads', input: 'a\x1bXhidden\x98hidden-pm\x1b^data\x1b\\b', expected: 'ab' },
  { name: 'C1 DCS and C1 OSC with ST terminators', input: 'a\x90rgb:ff/00/00\x9c\x9d0;title\x9cb', expected: 'ab' },
  { name: 'C1 OSC with BEL terminator', input: 'a\x9d0;t\x07b', expected: 'ab' },
  { name: '8-bit CSI', input: 'a\x9b31mred\x9b0mb', expected: 'aredb' },
  { name: 'CSI private and color', input: '\x1b[?25l\x1b[38;5;196mred\x1b[0m', expected: 'red' },
  { name: 'two-byte escapes', input: 'a\x1b(M\x1bcb', expected: 'aMb' },
  { name: 'unterminated OSC opener', input: '\x1b]8;;http://x label', expected: '8;;http://x label' },
  { name: 'unterminated C1 opener', input: '\x9d8;;u label', expected: '8;;u label' },
  { name: 'truncated CSI', input: 'a\x1b[31', expected: 'a31' },
  { name: 'trailing bare ESC', input: 'a\x1b', expected: 'a' },
  { name: 'noncharacters and focus sentinel', input: 'a\ufdd0b\ufdefc\uf8ffd', expected: 'abcd' },
  { name: 'layout controls survive', input: 'a\nb\tc', expected: 'a\nb\tc' },
]

/** A walk that keeps exactly the text the scanner does not attribute to a sequence: `stripEscapeSequences` by hand. */
function scanned(text: string): string {
  let out = ''
  for (let index = 0; index < text.length;) {
    const sequence = terminalSequenceAt(text, index)
    if (sequence === undefined) {
      const unit = String.fromCodePoint(text.codePointAt(index)!)
      out += unit
      index += unit.length
    } else {
      index += sequence.length
    }
  }
  return out
}

const admitted = (input: string): string => {
  const result = validateMayflyUiNode(ui.text(input))
  expect(result.ok, JSON.stringify(input)).toBe(true)
  return (result as { value: { content: string } }).value.content
}

describe('the one terminal escape grammar', () => {
  it.each(CASES)('$name', ({ input, expected }) => {
    expect(sanitizePluginText(input)).toBe(expected)
    expect(admitted(input)).toBe(expected)
    expect(stripTerminalText(input)).toBe(expected)
    expect(scanned(input)).toBe(stripEscapeSequences(input))
  })

  it('anchors the scanner at a position and reports no sequence at visible text', () => {
    const input = 'a\x1b]8;;u\x1b\\b\x9b31mc'
    expect(terminalSequenceAt(input, 1)).toBe('\x1b]8;;u\x1b\\')
    expect(terminalSequenceAt(input, 10)).toBe('\x9b31m')
    expect(terminalSequenceAt(input, 0)).toBeUndefined()
    expect(terminalSequenceAt(input, 7)).toBe('\x1b\\')
    expect(terminalSequenceAt(input, 2)).toBeUndefined()
    expect(terminalSequenceAt(input, 9)).toBeUndefined()
  })

  const PIECES = [
    '\x1b]0;title', '\x07', '\x1b\\', '\x9c', '\x9d', '\x90', '\x98', '\x1bP', '\x1bX', '\x1b^', '\x1b_', '\x1b[31m', '\x1b[', '\x9b1;2H', '\x1b[?25',
    'plain ', 'text\n', '\\', ']', '\x1b', '\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\', 'é', '\ufdd0', '\uf8ff',
  ]

  it('agrees across paint, admission, and the scanner on mixed sequences', () => {
    let state = 20_261_011
    const next = (): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296 }
    for (let count = 0; count < 6_000; count += 1) {
      const sample = Array.from({ length: 1 + Math.floor(next() * 14) }, () => PIECES[Math.floor(next() * PIECES.length)]!).join('')
      expect(sanitizePluginText(sample), JSON.stringify(sample)).toBe(stripTerminalText(sample))
      expect(admitted(sample), JSON.stringify(sample)).toBe(sanitizePluginText(sample))
      expect(scanned(sample), JSON.stringify(sample)).toBe(stripEscapeSequences(sample))
    }
  })

  it('strips thousands of unterminated openers in linear time', () => {
    const opener = '\x1b]0;x'.repeat(262_144 / 6)
    let started = performance.now()
    expect(sanitizePluginText(opener)).toBe('0;x'.repeat(262_144 / 6))
    expect(performance.now() - started).toBeLessThan(500)
    started = performance.now()
    const result = validateMayflyUiNode(ui.text(opener))
    expect(result.ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
