/**
 * The pure present resolvers: argument parsing plus the contained
 * presenter-call matrix (unknown tool, no presenter, decline, throw, happy).
 */

import { describe, expect, it, vi } from 'vitest'
import { parseToolArguments, resolveCallView, resolveResultView, summarizeToolCall, type ToolPresentationSource } from '../../src/transcript/present.ts'

/** A registry stub whose `get` returns the prearranged runtime (or nothing). */
function tools(get: (name: string) => unknown): ToolPresentationSource {
  return { get } as ToolPresentationSource
}

describe('parseToolArguments', () => {
  it('parses valid JSON', () => {
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: 'ls' })
    expect(parseToolArguments('[]')).toEqual([])
  })

  it('returns undefined for invalid JSON', () => {
    expect(parseToolArguments('{"command":')).toBeUndefined()
    expect(parseToolArguments('')).toBeUndefined()
  })
})

describe('summarizeToolCall', () => {
  it('renders object arguments as key/value lines under the tool name', () => {
    expect(summarizeToolCall('read', '{"file_path":"src/a.ts","limit":100}')).toBe('read\n  file_path: src/a.ts\n  limit: 100')
  })

  it('caps pairs, flattens values, and counts the dropped tail', () => {
    const args = JSON.stringify(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${String(index)}`, index])))
    expect(summarizeToolCall('probe', args)).toBe(
      'probe\n  k0: 0\n  k1: 1\n  k2: 2\n  k3: 3\n  k4: 4\n  k5: 5\n  … +2 more',
    )
    const long = JSON.stringify({ command: 'a\nb'.repeat(30) })
    expect(summarizeToolCall('bash', long)).not.toContain('\nb')
    expect(summarizeToolCall('probe', JSON.stringify({ flag: true, nested: { deep: [1, 2] } }))).toContain('flag: true')
    expect(summarizeToolCall('probe', JSON.stringify({ nested: { deep: [1, 2] } }))).toContain('nested: {"deep":[1,2]}')
  })

  it('keeps the inline form for non-object and unparseable arguments', () => {
    expect(summarizeToolCall('probe', '"just-a-string"')).toBe('probe("just-a-string")')
    expect(summarizeToolCall('probe', '[1,2]')).toBe('probe([1,2])')
    expect(summarizeToolCall('probe', 'not json')).toBe('probe(not json)')
  })
})

describe('resolveCallView', () => {
  const view = { card: 'terminal' } as never

  it('returns undefined for an unknown tool', () => {
    const source = tools(() => undefined)
    expect(resolveCallView(source, 'nope', {})).toBeUndefined()
  })

  it('returns undefined when the tool declares no presenter', () => {
    const source = tools(() => ({}))
    expect(resolveCallView(source, 'bash', {})).toBeUndefined()
  })

  it('returns undefined when the presenter declines', () => {
    const source = tools(() => ({ presentCall: () => undefined }))
    expect(resolveCallView(source, 'bash', {})).toBeUndefined()
  })

  it('returns undefined when the presenter throws', () => {
    const source = tools(() => ({ presentCall: () => { throw new Error('boom') } }))
    expect(resolveCallView(source, 'bash', {})).toBeUndefined()
  })

  it('returns the presenter view on the happy path', () => {
    const source = tools(() => ({ presentCall: () => view }))
    expect(resolveCallView(source, 'bash', { command: 'ls' })).toBe(view)
  })
})

describe('resolveResultView', () => {
  const result = { content: [], isError: false } as never
  const view = { card: 'diff' } as never

  it('returns undefined for an unknown tool', () => {
    const source = tools(() => undefined)
    expect(resolveResultView(source, 'nope', {}, result)).toBeUndefined()
  })

  it('returns undefined when the tool declares no presenter', () => {
    const source = tools(() => ({}))
    expect(resolveResultView(source, 'edit', {}, result)).toBeUndefined()
  })

  it('returns undefined when the presenter declines', () => {
    const source = tools(() => ({ presentResult: () => undefined }))
    expect(resolveResultView(source, 'edit', {}, result)).toBeUndefined()
  })

  it('returns undefined when the presenter throws', () => {
    const source = tools(() => ({ presentResult: () => { throw new Error('boom') } }))
    expect(resolveResultView(source, 'edit', {}, result)).toBeUndefined()
  })

  it('returns the presenter view on the happy path', () => {
    const source = tools(() => ({ presentResult: (_args: unknown, got: unknown) => (got === result ? view : undefined) }))
    expect(resolveResultView(source, 'edit', {}, result)).toBe(view)
  })
})

describe('scoped native call identity', () => {
  it('forwards the same exact call identity to both phases without changing native registry scope', () => {
    const lookups: unknown[][] = []
    const result = { content: [], isError: false }
    const source: ToolPresentationSource = {
      get: vi.fn(() => undefined),
      getForCall(name, callId) {
        lookups.push([name, callId])
        return { presentCall: args => args, presentResult: (_args, value) => value }
      },
    }
    expect(resolveCallView(source, 'read', { file_path: 'same.txt' }, 'exact-call')).toEqual({ file_path: 'same.txt' })
    expect(resolveResultView(source, 'read', {}, result, 'exact-call')).toBe(result)
    expect(lookups).toEqual([['read', 'exact-call'], ['read', 'exact-call']])
    expect(resolveCallView(source, 'read', {})).toBeUndefined()
    expect(resolveResultView(source, 'read', {}, result)).toBeUndefined()
    expect(source.get).not.toHaveBeenCalled()
    const native = { get: vi.fn((name: string, scope?: object) => {
      expect(scope).toBeUndefined()
      return { presentCall: () => name, presentResult: (_args: unknown, result: unknown) => result }
    }) }
    expect(resolveCallView(native, 'native', {}, 'exact-call')).toBe('native')
    expect(resolveResultView(native, 'native', {}, result, 'exact-call')).toBe(result)
    expect(native.get.mock.calls).toEqual([['native'], ['native']])
  })

  it('never falls back from a missing exact call to a native definition or another call', () => {
    const source: ToolPresentationSource = { get: vi.fn(() => ({ presentCall: () => 'wrong call', presentResult: () => 'wrong result' })), getForCall: vi.fn(() => undefined) }
    expect(resolveCallView(source, 'read', {}, 'missing')).toBeUndefined()
    expect(resolveResultView(source, 'read', {}, { content: [], isError: false }, 'missing')).toBeUndefined()
    expect(source.get).not.toHaveBeenCalled()
    expect(source.getForCall).toHaveBeenCalledTimes(2)
  })
})
