import { describe, expect, it, vi } from 'vitest'
import { RemoteFeatureCommandRegistry, mergeRemoteFeatureCommandSources } from '../../src/remote/features/commands.ts'

describe('RemoteFeatureCommandRegistry', () => {
  it('normalizes aliases, dispatches them, hides composition routes, and releases exact registrations', async () => {
    const registry = new RemoteFeatureCommandRegistry()
    const execute = vi.fn()
    const aliases = [' THINKING ']
    const off = registry.register({ name: ' Effort ', aliases, description: 'effort', execute })
    registry.register({ name: 'providers', hidden: true, description: 'internal', execute })
    aliases[0] = 'changed'
    const signal = new AbortController().signal
    expect(registry.list().map(entry => [entry.name, entry.aliases])).toEqual([['effort', ['thinking']]])
    await expect(registry.execute('THINKING', 'high', signal)).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith('high', signal)
    await expect(registry.execute('providers', '', signal)).resolves.toBe(true)
    off()
    off()
    const offNext = registry.register({ name: 'effort', description: 'next', execute })
    off()
    expect(registry.list()).toHaveLength(1)
    offNext()
    await expect(registry.execute('thinking', '', signal)).resolves.toBe(false)
    registry.clear()
    expect(registry.list()).toEqual([])
  })

  it('rejects invalid names and aliases or ambiguous routing before registration', () => {
    const registry = new RemoteFeatureCommandRegistry()
    const command = { description: 'x', execute: vi.fn() }
    expect(() => registry.register({ ...command, name: '/wrong' })).toThrow('Invalid')
    expect(() => registry.register({ ...command, name: 'effort', aliases: ['bad alias'] })).toThrow('Invalid')
    expect(() => registry.register({ ...command, name: 'effort', aliases: ['EFFORT'] })).toThrow('already registered')
    registry.register({ ...command, name: 'effort', aliases: ['thinking'] })
    expect(() => registry.register({ ...command, name: 'effort' })).toThrow('already registered')
    expect(() => registry.register({ ...command, name: 'thinking' })).toThrow('already registered')
    expect(() => registry.register({ ...command, name: 'other', aliases: ['thinking'] })).toThrow('already registered')
    expect(() => registry.register({ ...command, name: 'other', aliases: ['effort'] })).toThrow('already registered')
    expect(registry.list()).toHaveLength(1)
  })

  it('merges visible commands in name order and dispatches to the first owning source', async () => {
    const first = new RemoteFeatureCommandRegistry()
    const second = new RemoteFeatureCommandRegistry()
    const runFirst = vi.fn()
    const runSecond = vi.fn()
    first.register({ name: 'zebra', description: 'first', execute: runFirst })
    second.register({ name: 'zebra', description: 'second', execute: runSecond })
    second.register({ name: 'alpha', description: 'alpha', execute: runSecond })
    const merged = mergeRemoteFeatureCommandSources(first, second)
    expect(merged.list().map(entry => [entry.name, entry.description])).toEqual([['alpha', 'alpha'], ['zebra', 'first']])
    const signal = new AbortController().signal
    await expect(merged.execute('zebra', 'value', signal)).resolves.toBe(true)
    expect(runFirst).toHaveBeenCalledWith('value', signal)
    expect(runSecond).not.toHaveBeenCalled()
    await expect(merged.execute('alpha', '', signal)).resolves.toBe(true)
    await expect(merged.execute('missing', '', signal)).resolves.toBe(false)
  })
})
