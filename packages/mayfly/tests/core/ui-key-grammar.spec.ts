/** Declarative key grammar: dispatch order and hint derivation from one binding list.
 * @module @ephemeral-ai/mayfly/tests/core/ui-key-grammar
 */
import { describe, expect, it } from 'vitest'
import { ACTION_FOCUS_NEXT, ACTION_FOCUS_PREV, ACTION_MOVE_DOWN, ACTION_MOVE_UP, ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, ACTION_SUBMIT, printableKey } from '../../src/core/key-actions.ts'
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
    expect(grammarHints(bindings)).toEqual([{ id: 'keyed:2', keys: 'Ctrl+R', label: 'run', priority: 96 }])
  })

  it('hints an action with several keys once, at its first key that may fire', () => {
    const bindings = keyGrammar(state({ control: { kind: 'empty-list' }, list: { filterable: true, searching: false, query: false, pasting: false }, keyed: [
      { control: 3, key: 'd', label: 'delete' },
      { control: 3, key: 'ctrl+d', label: 'delete' },
      { control: 3, key: 'f9', label: 'delete' },
    ] }))
    expect(bindings.filter(binding => binding.intent.kind === 'keyed').map(binding => binding.match)).toEqual([{ kind: 'key', key: 'ctrl+d' }, { kind: 'key', key: 'f9' }])
    expect(grammarHints(bindings).filter(hint => hint.id === 'keyed:3')).toEqual([{ id: 'keyed:3', keys: 'Ctrl+D', label: 'delete', priority: 96 }])
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

  it('offers Delete on a changed field unless a declared accelerator owns it or text is being edited', () => {
    const field = { kind: 'select', multiple: false, picker: false, adjustable: true } as const
    const reset = (overrides: Partial<GrammarState>) => grammarHints(keyGrammar(state({ control: field, reset: 'inherit', ...overrides }))).find(hint => hint.id === 'reset')
    expect(reset({})).toMatchObject({ label: 'use inherited' })
    expect(reset({ reset: 'reset' })).toMatchObject({ label: 'reset' })
    expect(reset({ keyed: [{ control: 2, key: 'delete', label: 'Delete row' }] })).toBeUndefined()
    expect(reset({ control: { kind: 'text', field: 'input', editing: true, enterSubmits: false } })).toBeUndefined()
    expect(reset({ control: { kind: 'row', role: 'choose', multiple: false, tree: false } })).toBeUndefined()
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

describe('tabs, rails, and the ← ladder in the grammar', () => {
  const intents = (overrides: Partial<GrammarState>, key: string) => keyGrammar(state(overrides)).filter(binding => binding.match.kind === 'action' && binding.match.action === key).map(binding => binding.intent.kind)
  const labels = (overrides: Partial<GrammarState>) => grammarHints(keyGrammar(state(overrides))).find(hint => hint.id === 'labels')
  const select = (stuck: boolean, extra: object = {}) => ({ kind: 'select', multiple: false, picker: false, adjustable: true, ...(stuck ? { stuckLeft: true } : {}), ...extra }) as const

  it('moves a rail with ↑/↓, enters its content with → or Enter, and leaves ← to nothing', () => {
    const rail = state({ control: { kind: 'tab', vertical: true }, siblings: 3 })
    expect(intents(rail, ACTION_MOVE_UP)).toEqual(['tab-move'])
    expect(intents(rail, ACTION_MOVE_DOWN)).toEqual(['tab-move'])
    expect(intents(rail, ACTION_SEGMENT_RIGHT)).toEqual(['tab-descend'])
    expect(intents(rail, ACTION_SUBMIT)).toEqual(['tab-descend'])
    expect(intents(rail, ACTION_SEGMENT_LEFT)).toEqual(['swallow'])
    expect(grammarHints(keyGrammar(rail)).map(hint => [hint.id, hint.label, hint.actions])).toEqual([
      ['navigate', 'labels', [ACTION_MOVE_UP, ACTION_MOVE_DOWN]], ['activate', 'open', [ACTION_SEGMENT_RIGHT]],
    ])
    expect(intents({ control: { kind: 'tab' }, siblings: 3 }, ACTION_SEGMENT_LEFT)).toEqual(['tab-move'])
  })

  it('words the tab switch with the strip\'s hint word, and binds the focus levels everywhere outside editing', () => {
    expect(grammarHints(keyGrammar(state({ tabs: true, control: { kind: 'empty-list' } }))).find(hint => hint.id === 'tabs')).toMatchObject({ label: 'tabs' })
    expect(grammarHints(keyGrammar(state({ tabs: true, tabsLabel: 'views', control: { kind: 'empty-list' } }))).find(hint => hint.id === 'tabs')).toMatchObject({ label: 'views' })
    for (const control of [{ kind: 'scroll' }, { kind: 'toggle' }, { kind: 'empty-list' }, { kind: 'tab' }] as const) {
      expect(intents({ control }, ACTION_FOCUS_PREV)).toEqual(['focus-level'])
      expect(intents({ control }, ACTION_FOCUS_NEXT)).toEqual(['focus-level'])
    }
    expect(intents({ control: { kind: 'text', field: 'input', editing: true, enterSubmits: false } }, ACTION_FOCUS_NEXT)).toEqual([])
    expect(intents({ control: select(false, { picker: true }) }, ACTION_FOCUS_NEXT)).toEqual([])
  })

  it('hints ← labels only where an unused ← would reach the rail', () => {
    const rail = { railBack: true }
    // A select uses ← while an earlier option exists; at the first option it does not.
    expect(intents({ control: select(false), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['select-cycle', 'navigate'])
    expect(labels({ control: select(false), ...rail })).toBeUndefined()
    expect(intents({ control: select(true), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(labels({ control: select(true), ...rail })).toMatchObject({ label: 'labels', priority: 94 })
    expect(grammarHints(keyGrammar(state({ control: select(true), ...rail }))).find(hint => hint.id === 'adjust')).toMatchObject({ label: 'adjust' })
    // A select with nothing to adjust, and a multiselect, hand ← over too.
    expect(intents({ control: select(false, { adjustable: false }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(intents({ control: select(false, { multiple: true }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    // Without a rail nothing changes.
    expect(intents({ control: select(true) }, ACTION_SEGMENT_LEFT)).toEqual(['navigate'])
    expect(labels({ control: select(true) })).toBeUndefined()
  })

  it('hands ← from a stuck segment strip, a closed branch, and a plain row to the rail, and keeps it for a row that uses it', () => {
    const row = (extra: object) => ({ kind: 'row', role: 'browse', multiple: false, tree: false, ...extra }) as const
    const rail = { railBack: true }
    expect(intents({ control: row({ segment: 'thinking' }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['segment'])
    expect(labels({ control: row({ segment: 'thinking' }), ...rail })).toBeUndefined()
    expect(intents({ control: row({ segment: 'thinking', stuckLeft: true }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(grammarHints(keyGrammar(state({ control: row({ segment: 'thinking', stuckLeft: true }), ...rail }))).find(hint => hint.id === 'adjust')).toMatchObject({ label: 'thinking' })
    expect(intents({ control: row({ segment: 'thinking', stuckLeft: true }) }, ACTION_SEGMENT_LEFT)).toEqual([])
    expect(intents({ control: row({ expandable: true }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['branch'])
    expect(intents({ control: row({ expandable: true, stuckLeft: true }), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(grammarHints(keyGrammar(state({ control: row({ expandable: true, stuckLeft: true }), ...rail }))).find(hint => hint.id === 'branch')).toMatchObject({ label: 'branch' })
    expect(intents({ control: row({ tree: true, multiple: true, stuckLeft: true }) }, ACTION_SEGMENT_LEFT)).toEqual([])
    expect(intents({ control: row({}), ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(intents({ control: row({}) }, ACTION_SEGMENT_LEFT)).toEqual(['navigate'])
  })

  it('hands ← to the rail from every control that has no ← of its own', () => {
    const rail = { railBack: true }
    for (const control of [{ kind: 'scroll' }, { kind: 'empty-list' }, { kind: 'toggle' }, { kind: 'submit' }] as const) {
      expect(intents({ control, ...rail }, ACTION_SEGMENT_LEFT), control.kind).toEqual(['rail-back'])
      expect(labels({ control, ...rail }), control.kind).toMatchObject({ label: 'labels' })
      expect(labels({ control }), control.kind).toBeUndefined()
    }
    // A field's own button keeps its sideways relationship to the field.
    expect(intents({ control: { kind: 'field-action' }, ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['navigate'])
    // Along an actions row ← steps back until the first action.
    expect(intents({ control: { kind: 'action', decision: false }, ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['navigate'])
    expect(intents({ control: { kind: 'action', decision: false }, groupStart: true, ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(intents({ control: { kind: 'cancel' }, groupStart: true, ...rail }, ACTION_SEGMENT_LEFT)).toEqual(['rail-back'])
    expect(intents({ control: { kind: 'action', decision: false }, groupStart: true }, ACTION_SEGMENT_LEFT)).toEqual(['navigate'])
  })

  it('words the Escape that returns home `back`', () => {
    expect(grammarHints(keyGrammar(state({ escape: 'home', control: { kind: 'toggle' } }))).find(hint => hint.id === 'escape')).toMatchObject({ label: 'back' })
  })
})
