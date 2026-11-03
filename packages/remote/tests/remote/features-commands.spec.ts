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
    expect(registry.resolve('THINKING')).toBe(registry.resolve('effort'))
    expect(registry.resolve('providers')).toMatchObject({ name: 'providers', hidden: true })
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
    expect(registry.resolve('thinking')).toBeUndefined()
    registry.clear()
    expect(registry.list()).toEqual([])
    expect(registry.resolve('providers')).toBeUndefined()
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
    expect(merged.resolve('zebra')).toBe(first.resolve('zebra'))
    expect(merged.resolve('alpha')).toBe(second.resolve('alpha'))
    expect(merged.resolve('missing')).toBeUndefined()
  })

  it('resolves hidden owners with the same source precedence as dispatch and retires exact descriptors on unload', async () => {
    const first = new RemoteFeatureCommandRegistry()
    const second = new RemoteFeatureCommandRegistry()
    const runFirst = vi.fn(), runSecond = vi.fn()
    const off = first.register({ name: 'internal', aliases: ['private'], hidden: true, description: 'first hidden', execute: runFirst })
    second.register({ name: 'internal', aliases: ['private'], description: 'second visible', execute: runSecond })
    const merged = mergeRemoteFeatureCommandSources(first, second)
    const captured = merged.resolve('PRIVATE')
    expect(captured).toBe(first.resolve('internal'))
    const signal = new AbortController().signal
    await expect(merged.execute('private', 'original owner', signal)).resolves.toBe(true)
    expect(runFirst).toHaveBeenCalledWith('original owner', signal)
    expect(runSecond).not.toHaveBeenCalled()
    off()
    expect(merged.resolve('private')).toBe(second.resolve('internal'))
    expect(merged.resolve('private')).not.toBe(captured)
    await expect(merged.execute('private', 'replacement owner', signal)).resolves.toBe(true)
    expect(runSecond).toHaveBeenCalledWith('replacement owner', signal)
    second.clear()
    expect(merged.resolve('private')).toBeUndefined()
  })
})
