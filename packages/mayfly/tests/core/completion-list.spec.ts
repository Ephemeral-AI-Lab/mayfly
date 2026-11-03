/**
 * Decisions of the completion list's state: its kind comes from the prefix the provider matched, and each row carries
 * its detail, extension source, and problem to the drawer. pi-tui keeps the filtering and the keys.
 * @module @ephemeral-ai/mayfly/tests/core/completion-list
 */
import { describe, expect, it } from 'vitest'
import { CompletionList } from '../../src/core/completion-list.ts'

const theme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
} as never

describe('CompletionList', () => {
  it('reads its kind from the prefix the provider matched', () => {
    expect(new CompletionList([{ value: '/model', label: '/model' }], 6, theme, '/mo').view().kind).toBe('commands')
    expect(new CompletionList([{ value: '@a.ts', label: 'a.ts' }], 6, theme, '@a').view().kind).toBe('files')
    expect(new CompletionList([{ value: '#skill', label: 'skill' }], 6, theme, '#s').view().kind).toBe('completions')
  })

  it('carries each row as a fact: its label, detail, source, and problem, and the focused index', () => {
    const list = new CompletionList([
      { value: '/one', label: '', description: 'the first' },
      { value: '/two', label: '/two', description: undefined, source: 'acme.ext', problem: 'stale' } as never,
    ], 6, theme, '/')
    expect(list.view()).toEqual({
      kind: 'commands',
      prefix: '/',
      index: 0,
      items: [
        { label: '/one', value: '/one', detail: 'the first' },
        { label: '/two', value: '/two', source: 'acme.ext', problem: 'stale' },
      ],
    })
  })

  it('paints no rows of its own', () => {
    expect(new CompletionList([{ value: '/x', label: '/x' }], 6, theme, '/').render()).toEqual([])
  })
})
