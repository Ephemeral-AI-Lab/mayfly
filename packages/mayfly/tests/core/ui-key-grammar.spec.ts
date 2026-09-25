/** Declarative key grammar: dispatch order and hint derivation from one binding list.
 * @module @ephemeral-ai/mayfly/tests/core/ui-key-grammar
 */
import { describe, expect, it } from 'vitest'
import { ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, printableKey } from '../../src/core/key-actions.ts'
import { grammarHints, keyGrammar, type GrammarState } from '../../src/core/ui-key-grammar.ts'

function state(overrides: Partial<GrammarState>): GrammarState {
  return { mode: 'ui', expanded: false, control: { kind: 'none' }, keyed: [], tabs: false, groups: 1, siblings: 1, escape: undefined, closable: false, ...overrides }
}

describe('printable key ids', () => {
  it('separates text-inserting keys from modifier chords and named keys', () => {
    expect(['space', 'q', 'Q', 'shift+q', '/'].map(printableKey)).toEqual([true, true, true, true, true])
    expect(['ctrl+r', 'alt+enter', 'alt+q', 'f5', 'delete', 'ctrl+shift+x'].map(printableKey)).toEqual([false, false, false, false, false, false])
  })
})

describe('key grammar', () => {
  it('leaves an editor shell to the host editor except for modifier accelerators', () => {
    const bindings = keyGrammar(state({ mode: 'editor', control: { kind: 'editor' }, keyed: [
      { control: 1, key: 'q', label: 'Quit' },
      { control: 2, key: 'ctrl+r', label: 'Run' },
    ] }))
    expect(bindings.map(binding => binding.intent.kind)).toEqual(['keyed', 'editor'])
    expect(grammarHints(bindings)).toEqual([{ id: 'keyed:ctrl+r', keys: 'Ctrl+R', label: 'Run', priority: 96 }])
  })

  it('discloses multi-select tree branches with left and right', () => {
    const hints = grammarHints(keyGrammar(state({
      control: { kind: 'row', role: 'choose', multiple: true, tree: true },
      list: { filterable: false, searching: false, query: false, pasting: false },
    })))
    expect(hints.find(hint => hint.id === 'branch')).toMatchObject({ label: 'branch', actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] })
  })

  it('advertises the real count of numbered rows and whether digits accept', () => {
    const numbered = (count: number, accept: boolean) => grammarHints(keyGrammar(state({
      control: { kind: 'row', role: 'choose', multiple: false, tree: false },
      list: { filterable: false, searching: false, query: false, pasting: false, numbered: { accept, count } },
    }))).find(hint => hint.id === 'numbered')
    expect(numbered(1, true)).toMatchObject({ keys: '1', label: 'choose' })
    expect(numbered(3, false)).toMatchObject({ keys: '1-3', label: 'focus' })
    expect(numbered(0, true)).toBeUndefined()
  })

  it('keeps the first hint for each id in binding order', () => {
    const hints = grammarHints([
      { match: { kind: 'any' }, intent: { kind: 'swallow' }, hint: { id: 'a', label: 'first', priority: 1 } },
      { match: { kind: 'any' }, intent: { kind: 'swallow' }, hint: { id: 'a', label: 'second', priority: 2 } },
      { match: { kind: 'any' }, intent: { kind: 'swallow' } },
    ])
    expect(hints).toEqual([{ id: 'a', label: 'first', priority: 1 }])
  })
})
