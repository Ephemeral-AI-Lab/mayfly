/**
 * Escape-sequence stripping (`core/escape-sequences.ts`) behind admission (`ui-validator.ts`) and the painters
 * (`plugin-view.ts`): the output equals the unsplit regex on any mix of terminated and unterminated sequences, and
 * thousands of unterminated openers cost linear time.
 *
 * @module @ephemeral-ai/mayfly/core/tests/escape-sequences
 */

import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { sanitizePluginText } from '../../src/core/plugin-view.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

const VALIDATOR_WHOLE = /(?:(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b.)/gu
const VALIDATOR_UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uf8ff\ufdd0-\ufdef]/gu
const PLUGIN_WHOLE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu
const PLUGIN_UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uf8ff]/gu

const PIECES = [
  '\x1b]0;title', '\x07', '\x1b\\', '\x9c', '\x9d', '\x90', '\x98', '\x1bP', '\x1bX', '\x1b^', '\x1b_', '\x1b[31m', '\x1b[', '\x9b1;2H', '\x1b[?25',
  'plain ', 'text\n', '\\', ']', '\x1b', '\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\', 'é', '\ufdd0', '\uf8ff',
]

function fuzz(seed: number, count: number): string[] {
  let state = seed
  const next = (): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296 }
  return Array.from({ length: count }, () => Array.from({ length: 1 + Math.floor(next() * 14) }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(''))
}

describe('escape sequence stripping', () => {
  const samples = fuzz(20_261_011, 6_000)

  it('matches the unsplit plugin-view pattern on mixed sequences', () => {
    for (const sample of samples) expect(sanitizePluginText(sample), JSON.stringify(sample)).toBe(sample.replace(PLUGIN_WHOLE, '').replace(PLUGIN_UNSAFE, ''))
  })

  it('matches the unsplit admission pattern on mixed sequences', () => {
    for (const sample of samples) {
      const admitted = validateMayflyUiNode(ui.text(sample))
      expect(admitted.ok, JSON.stringify(sample)).toBe(true)
      if (admitted.ok) expect((admitted.value as { content: unknown }).content, JSON.stringify(sample)).toBe(sample.replace(VALIDATOR_WHOLE, '').replace(VALIDATOR_UNSAFE, ''))
    }
  })

  it('strips thousands of unterminated openers in linear time', () => {
    const opener = '\x1b]0;x'.repeat(262_144 / 6)
    let started = performance.now()
    expect(sanitizePluginText(opener)).toBe('0;x'.repeat(262_144 / 6))
    expect(performance.now() - started).toBeLessThan(500)
    started = performance.now()
    const admitted = validateMayflyUiNode(ui.text(opener))
    expect(admitted.ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
