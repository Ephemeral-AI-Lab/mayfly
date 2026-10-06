/**
 * The key audit (implementation roadmap, slice 1.0): the shipped default keys never collide, no printable key is
 * bound where text is typed, and every Alt default either has a plain alternative or is a recorded gap that slice
 * 1.7 closes. Scopes do not exist yet, so the grammar's focus states stand in for them.
 */
import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MayflyKeymapService } from '../../src/core/keymap.ts'
import { keyActionKeys, printableKey } from '../../src/core/key-actions.ts'
import { keyGrammar, type EscapeStep, type GrammarBinding, type GrammarControl, type GrammarState } from '../../src/core/ui-key-grammar.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/keys.ts'
import { ACTION_IMAGE_PASTE } from '../../src/interaction/paste-image.ts'
import { ACTION_TOGGLE_COLLAPSE } from '../../src/transcript/index.ts'
import { ACTION_TOGGLE_TODO } from '../../src/transcript/pane-todo.ts'
import type { MayflyKeyAction } from '../../src/core/types.ts'

/** Defaults registered inline by their owners; `drift` proves this table still matches the source text. */
const PRODUCT_KEY_ACTIONS: readonly (MayflyKeyAction & { readonly source: string, readonly handler?: () => void })[] = [
  { id: 'mayfly.surface.next', keys: 'f6', source: '../../src/core/surface-renderer.ts', handler: () => {} },
  { id: 'mayfly.surface.previous', keys: 'shift+f6', source: '../../src/core/surface-renderer.ts', handler: () => {} },
  { id: ACTION_IMAGE_PASTE, keys: 'ctrl+v', source: '../../src/interaction/paste-image.ts' },
  { id: ACTION_TOGGLE_COLLAPSE, keys: 'ctrl+o', source: '../../src/transcript/index.ts', handler: () => {} },
  { id: ACTION_TOGGLE_TODO, keys: 'ctrl+t', source: '../../src/transcript/pane-todo.ts', handler: () => {} },
]

/**
 * Alt defaults without a plain alternative today. Slice 1.7 adds F2-F5 and the plain tab and newline keys and must
 * remove each entry as it lands; an entry whose action already has a plain key fails the audit as stale.
 */
const KNOWN_ALT_GAPS: readonly string[] = [
  'mayfly.interaction.prev-tab',
  'mayfly.interaction.next-tab',
  'mayfly.interaction.newline',
  'mayfly.interaction.cycle-model',
]

const defaults = (): MayflyKeyAction[] => [...INTERACTION_KEY_ACTIONS, ...PRODUCT_KEY_ACTIONS.map(({ source: _source, ...action }) => action)]
const keysOf = (action: MayflyKeyAction): string[] => [action.keys].flat().map(key => key.toLowerCase())

function registry(): MayflyKeymapService {
  const keymap = new MayflyKeymapService(new Context())
  keymap.register(defaults())
  return keymap
}

const ESCAPES: readonly (EscapeStep | undefined)[] = [undefined, 'close']
const CONTROLS: readonly GrammarControl[] = [
  { kind: 'none' }, { kind: 'scroll' }, { kind: 'toggle' }, { kind: 'submit' }, { kind: 'field-action' }, { kind: 'tab' }, { kind: 'empty-list' }, { kind: 'cancel' },
  { kind: 'action', decision: false }, { kind: 'action', decision: true },
  ...(['input', 'textarea', 'secret', 'number'] as const).flatMap(field => [true, false].flatMap(editing => [true, false].map(enterSubmits => ({ kind: 'text', field, editing, enterSubmits }) as const))),
  ...[true, false].flatMap(multiple => [true, false].flatMap(picker => [true, false].map(adjustable => ({ kind: 'select', multiple, picker, adjustable }) as const))),
  ...(['browse', 'choose'] as const).flatMap(role => [true, false].flatMap(multiple => [true, false].map(tree => ({ kind: 'row', role, multiple, tree }) as const))),
  { kind: 'row', role: 'browse', multiple: false, tree: false, segment: 'thinking' },
]
const LISTS: readonly NonNullable<GrammarState['list']>[] = [
  { filterable: false, searching: false, query: false, pasting: false },
  { filterable: true, searching: false, query: false, pasting: false },
  { filterable: true, searching: true, query: true, pasting: false },
  { filterable: true, searching: false, query: true, pasting: true },
  { filterable: false, searching: false, query: false, pasting: false, numbered: { accept: true, count: 3 } },
]

function states(mode: GrammarState['mode'], controls: readonly GrammarControl[]): GrammarState[] {
  const result: GrammarState[] = []
  for (const control of controls) {
    const lists = control.kind === 'row' || control.kind === 'empty-list' ? LISTS : [undefined]
    for (const list of lists) for (const expanded of [false, true]) for (const escape of ESCAPES) for (const closable of [false, true]) {
      for (const keyed of [[], [{ control: 0, key: 'c', label: 'copy' }], [{ control: 0, key: 'ctrl+y', label: 'copy link' }]]) for (const tabs of [false, true]) for (const groups of [0, 2]) {
        for (const reset of [undefined, 'reset', 'inherit'] as const) {
          result.push({ mode, expanded, control, ...(list === undefined ? {} : { list }), keyed, tabs, groups, siblings: groups, escape, closable, ...(reset === undefined ? {} : { reset }) })
        }
      }
    }
  }
  return result
}

/** The keys one binding matches, through the live registry. */
function matchedKeys(binding: GrammarBinding, keymap: MayflyKeymapService): string[] {
  if (binding.match.kind === 'action') return [...keyActionKeys(keymap, binding.match.action)]
  if (binding.match.kind === 'key') return [binding.match.key.toLowerCase()]
  return []
}

describe('default keys', () => {
  it('register as one batch without a collision', () => {
    const keymap = registry()
    expect(keymap.list()).toHaveLength(INTERACTION_KEY_ACTIONS.length + PRODUCT_KEY_ACTIONS.length)
    expect(new Set(keymap.list().flatMap(action => [action.keys].flat())).size).toBe(keymap.list().flatMap(action => [action.keys].flat()).length)
  })

  it.each(PRODUCT_KEY_ACTIONS)('keeps $id in step with its owner ($keys)', ({ id, keys, source }) => {
    const text = readFileSync(new URL(source, import.meta.url), 'utf8')
    expect(text).toMatch(new RegExp(`keys: \\[?'${String(keys).replace('+', '\\+')}'\\]?`, 'u'))
    expect(text).toMatch(new RegExp(`id: ${id.startsWith('mayfly.surface') ? `'${id}'` : '[A-Z_]+'}`, 'u'))
  })

  it('binds no printable key to a global handler', () => {
    for (const action of defaults().filter(candidate => candidate.handler !== undefined)) {
      expect(keysOf(action).filter(printableKey), action.id).toEqual([])
    }
  })
})

describe('Alt defaults', () => {
  const altActions = (): MayflyKeyAction[] => defaults().filter(action => keysOf(action).some(key => key.includes('alt+')))

  it('either have a plain alternative or are a recorded gap', () => {
    const missing = altActions().filter(action => !keysOf(action).some(key => !key.includes('alt+')) && !KNOWN_ALT_GAPS.includes(action.id)).map(action => action.id)
    expect(missing).toEqual([])
  })

  it('leave no gap entry stale', () => {
    const stale = KNOWN_ALT_GAPS.filter(id => {
      const action = defaults().find(candidate => candidate.id === id)
      return action === undefined || keysOf(action).some(key => !key.includes('alt+')) || !keysOf(action).some(key => key.includes('alt+'))
    })
    expect(stale).toEqual([])
  })
})

describe('grammar keys', () => {
  it('never route one key to two intents in a focus state, apart from the recorded overlaps', () => {
    const keymap = registry()
    const overlaps = new Set<string>()
    for (const state of states('ui', CONTROLS)) {
      const claimed = new Map<string, string>()
      for (const binding of keyGrammar(state)) {
        for (const key of matchedKeys(binding, keymap)) {
          const previous = claimed.get(key)
          if (previous === undefined) claimed.set(key, binding.intent.kind)
          else if (previous !== binding.intent.kind) overlaps.add(`${key}: ${previous} then ${binding.intent.kind}`)
        }
      }
    }
    expect([...overlaps].sort()).toEqual(KNOWN_OVERLAPS)
  })

  it('binds no printable key, and no text key, in the editor scope', () => {
    const keymap = registry()
    for (const state of states('editor', [{ kind: 'editor' }])) {
      const bindings = keyGrammar(state)
      expect(bindings.at(-1)).toMatchObject({ match: { kind: 'any' }, intent: { kind: 'editor' } })
      for (const binding of bindings.slice(0, -1)) {
        expect(['char', 'digit', 'text', 'backspace', 'any'], JSON.stringify(binding.match)).not.toContain(binding.match.kind)
        expect(matchedKeys(binding, keymap).filter(printableKey), JSON.stringify(binding.match)).toEqual([])
      }
    }
  })
})

/** Overlaps the grammar has today: the same key reaches a second intent only after the first declines it. */
const KNOWN_OVERLAPS: readonly string[] = ['left: select-cycle then navigate', 'right: select-cycle then navigate']
