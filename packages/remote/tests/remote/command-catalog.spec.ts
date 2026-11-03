/** Actual mounted discovery data is scoped, local-first and renderer-neutral. @module tests/remote/command-catalog */
import { describe, expect, it, vi } from 'vitest'
import { remoteCommandCatalog } from '../../src/remote/command-catalog.ts'
import type { RemoteFeatureCommandDefinition } from '../../src/remote/features/commands.ts'

const feature = (name: string, extra: Partial<RemoteFeatureCommandDefinition> = {}): RemoteFeatureCommandDefinition => ({
  name, description: `feature ${name}`, execute: vi.fn(), ...extra,
})

describe('actual Remote command catalog', () => {
  it('lists only explicit sessionless commands before a writable Session exists', () => {
    const commands = remoteCommandCatalog(false, [
      feature('theme', { scope: 'sessionless' }),
      feature('language', { scope: 'sessionless', group: 'remote' }),
      feature('private', { scope: 'sessionless', hidden: true }),
      feature('save'),
      feature('agent-command', { scope: 'session' }),
    ], [{ name: 'native', description: 'requires an actual Session' }])
    expect(commands.map(command => command.name)).toEqual(['attach', 'detach', 'help', 'host', 'language', 'new', 'quit', 'sessions', 'theme'])
    expect(commands.find(command => command.name === 'theme')).not.toHaveProperty('execute')
    expect(commands.find(command => command.name === 'language')).toMatchObject({ group: 'remote' })
    expect(commands.find(command => command.name === 'quit')).toMatchObject({ aliases: ['q', 'exit'] })
    expect(commands.find(command => command.name === 'sessions')).toMatchObject({ input: { hint: '[<session-id>]' }, aliases: ['resume'] })
  })

  it('keeps actual local, then feature, then native ownership with aliases and input hints intact', () => {
    const commands = remoteCommandCatalog(true, [
      feature('quit', { scope: 'sessionless', aliases: ['wrong'] }),
      feature('theme', { aliases: ['color'], input: { hint: '[name]' } }),
      feature('hidden', { hidden: true }),
      feature('theme', { description: 'later feature duplicate' }),
    ], [
      { name: 'quit', description: 'native quit' },
      { name: 'theme', description: 'native theme' },
      { name: 'compact', description: 'Compact history', input: { hint: '[instructions]' } },
    ])
    expect(commands.find(command => command.name === 'quit')).toEqual({ name: 'quit', description: 'Exit Mayfly', aliases: ['q', 'exit'] })
    expect(commands.find(command => command.name === 'theme')).toEqual({ name: 'theme', description: 'feature theme', aliases: ['color'], input: { hint: '[name]' } })
    expect(commands.find(command => command.name === 'compact')).toMatchObject({ input: { hint: '[instructions]' } })
    expect(commands.map(command => command.name)).toContain('init')
    expect(commands.find(command => command.name === 'fork')).not.toHaveProperty('input')
    expect(commands.find(command => command.name === 'rewind')).not.toHaveProperty('input')
    expect(commands.find(command => command.name === 'changelog')).toEqual({ name: 'changelog', description: "Show the release changelog (what's new)" })
    expect(commands.map(command => command.name)).not.toContain('hidden')
    expect(commands.map(command => command.name)).toEqual(commands.map(command => command.name).toSorted())
  })

  it('accepts an empty native directory without manufacturing feature commands', () => {
    const names = remoteCommandCatalog(true, []).map(command => command.name)
    expect(names).not.toContain('theme')
    expect(names).not.toContain('plugin')
    expect(names).not.toContain('model')
  })

  it('uses the start-surface plan contract only without a writable Session', () => {
    const nextSession = feature('plan', { scope: 'sessionless', input: { hint: '[off]' } })
    const native = { name: 'plan', description: 'Native selected Session plan', input: { hint: '[off|message]' } }
    expect(remoteCommandCatalog(false, [nextSession], [native]).find(command => command.name === 'plan'))
      .toMatchObject({ description: 'feature plan', input: { hint: '[off]' } })
    expect(remoteCommandCatalog(true, [nextSession], [native]).find(command => command.name === 'plan')).toEqual(native)
    expect(remoteCommandCatalog(true, [nextSession]).some(command => command.name === 'plan')).toBe(false)
  })

  it('reserves local aliases before feature/native discovery and removes aliases already owned by a real command', () => {
    const commands = remoteCommandCatalog(true, [
      feature('aaa', { aliases: ['help', 'quit', 'q', 'custom'] }),
      feature('clear'),
      feature('other', { aliases: [] }),
    ], [{ name: 'q', description: 'native duplicate alias' }, { name: 'resume', description: 'native duplicate alias' }])
    expect(commands.find(command => command.name === 'aaa')).toMatchObject({ aliases: ['custom'] })
    expect(commands.find(command => command.name === 'other')).not.toHaveProperty('aliases')
    expect(commands.map(command => command.name)).not.toContain('clear')
    expect(commands.map(command => command.name)).not.toContain('q')
    expect(commands.map(command => command.name)).not.toContain('resume')
  })
})
