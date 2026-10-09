/**
 * `ctx.mayflyKeymap` service: registration and disposal on the fiber, key
 * matching, and registration-time conflict detection.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MayflyKeymapError, MayflyKeymapService, actionOwner } from '../../src/core/keymap.ts'
import type { MayflyKeyAction } from '../../src/core/types.ts'

describe('MayflyKeymapService', () => {
  it('registers as ctx.mayflyKeymap and unregisters when the fiber disposes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MayflyKeymapService)
    await fiber
    expect(ctx.get('mayflyKeymap')).toBeInstanceOf(MayflyKeymapService)
    await fiber.dispose()
    expect(ctx.get('mayflyKeymap')).toBeUndefined()
  })

  it('answers matches from the keys it resolved, until a binding or a newly seen action changes them', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    const resolve = vi.spyOn(MayflyKeymapService.prototype, 'resolve')
    try {
      keymap.register([{ id: 'mayfly.test.save', keys: 'ctrl+s', scope: 'surface' }])
      expect(keymap.matches('\x13', 'mayfly.test.save')).toBe(true)
      expect(keymap.matches('\x13', 'mayfly.test.save')).toBe(true)
      expect(keymap.matches('a', 'mayfly.test.save')).toBe(false)
      expect(resolve).toHaveBeenCalledTimes(1)
      // An action nobody declared has no keys; seeing it gives it its defaults at once.
      expect(keymap.matches('\x0b', 'plugin.kit.open')).toBe(false)
      keymap.see([{ id: 'plugin.kit.open', label: 'Open', keys: ['ctrl+k'] }])
      expect(keymap.matches('\x0b', 'plugin.kit.open')).toBe(true)
      // A rebind retires the old key in the same turn.
      keymap.bind('mayfly.test.save', ['ctrl+w'])
      expect(keymap.matches('\x13', 'mayfly.test.save')).toBe(false)
      expect(keymap.matches('\x17', 'mayfly.test.save')).toBe(true)
      expect(keymap.dispatch('\x17')).toBe(false)
    } finally {
      resolve.mockRestore()
    }
  })

  it('counts every committed registration and disposal in its revision', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    const start = keymap.revision
    const dispose = keymap.register([{ id: 'mayfly.test.revision', keys: 'ctrl+r' }])
    expect(keymap.revision).toBe(start + 1)
    expect(() => keymap.register([{ id: 'mayfly.test.revision', keys: 'ctrl+t' }])).toThrow('already registered')
    expect(keymap.revision).toBe(start + 1)
    dispose()
    expect(keymap.revision).toBe(start + 2)
    dispose()
    expect(keymap.revision).toBe(start + 2)
  })

  it('matches input sequences against registered keys', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.app.quit', keys: ['ctrl+c', 'ctrl+d'], description: 'Quit' }])

    expect(keymap.matches('\x03', 'mayfly.app.quit')).toBe(true)
    expect(keymap.matches('\x04', 'mayfly.app.quit')).toBe(true)
    expect(keymap.matches('\r', 'mayfly.app.quit')).toBe(false)
    expect(keymap.getKeys('mayfly.app.quit')).toEqual(['ctrl+c', 'ctrl+d'])
  })

  it('accepts a single string key and never matches unknown actions', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.input.submit', keys: 'enter' }])

    expect(keymap.matches('\r', 'mayfly.input.submit')).toBe(true)
    expect(keymap.matches('\r', 'mayfly.input.nope')).toBe(false)
    expect(keymap.getKeys('mayfly.input.nope')).toEqual([])
  })

  it('dedupes repeated keys within one action', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.app.quit', keys: ['ctrl+c', 'ctrl+c'] }])
    expect(keymap.getKeys('mayfly.app.quit')).toEqual(['ctrl+c'])
  })

  it('rejects a key already claimed by another registered action', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+c' }])

    expect(() => keymap.register([{ id: 'mayfly.app.interrupt', keys: 'ctrl+c' }]))
      .toThrow(MayflyKeymapError)
    expect(() => keymap.register([{ id: 'mayfly.app.interrupt', keys: 'ctrl+c' }]))
      .toThrow(/"ctrl\+c" is claimed by both "mayfly\.app\.quit" and "mayfly\.app\.interrupt"/)
    // The rejected registration committed nothing.
    expect(keymap.matches('\x03', 'mayfly.app.interrupt')).toBe(false)
  })

  it('lets two scopes share a key, while a global action claims it everywhere', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([
      { id: 'mayfly.interaction.steer', keys: 'ctrl+s', scope: 'editor' },
      { id: 'ui.save', keys: 'ctrl+s', scope: 'surface' },
    ])
    expect(keymap.matches('\x13', 'mayfly.interaction.steer')).toBe(true)
    expect(keymap.matches('\x13', 'ui.save')).toBe(true)
    expect(() => keymap.register([{ id: 'demo-plugin.save', keys: 'ctrl+s', scope: 'surface' }]))
      .toThrow('key "ctrl+s" is claimed by both "ui.save" and "demo-plugin.save" (ui owns it in the surface scope)')
    expect(() => keymap.register([{ id: 'demo-plugin.everywhere', keys: 'ctrl+s' }])).toThrow(/claimed by both "mayfly\.interaction\.steer"/)
    keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+q' }])
    expect(() => keymap.register([{ id: 'demo-plugin.quit', keys: 'ctrl+q', scope: 'stream' }]))
      .toThrow('(mayfly owns it in the global scope)')
    expect(actionOwner('demo-plugin.install')).toBe('demo-plugin')
  })

  it('frees a shared key per scope when one claimant unregisters', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.interaction.steer', keys: 'ctrl+s', scope: 'editor' }])
    const dispose = keymap.register([{ id: 'ui.save', keys: 'ctrl+s', scope: 'surface' }])
    dispose()
    expect(() => keymap.register([{ id: 'demo-plugin.save', keys: 'ctrl+s', scope: 'surface' }])).not.toThrow()
    expect(() => keymap.register([{ id: 'demo-plugin.steer', keys: 'ctrl+s', scope: 'editor' }])).toThrow(/claimed by both "mayfly\.interaction\.steer"/)
  })

  it('rejects conflicting claims inside one batch without committing any', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap

    let caught: unknown
    try {
      keymap.register([
        { id: 'mayfly.a', keys: 'ctrl+x' },
        { id: 'mayfly.b', keys: 'ctrl+x' },
      ])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MayflyKeymapError)
    expect((caught as MayflyKeymapError).code).toBe('KEY_CONFLICT')
    expect(keymap.getKeys('mayfly.a')).toEqual([])
    expect(keymap.getKeys('mayfly.b')).toEqual([])
  })

  it('rejects duplicate action ids', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+c' }])

    expect(() => keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+q' }]))
      .toThrow(/"mayfly\.app\.quit" is already registered/)
    expect(() => keymap.register([
      { id: 'mayfly.dup', keys: 'f1' },
      { id: 'mayfly.dup', keys: 'f2' },
    ])).toThrow(/"mayfly\.dup" is already registered/)
  })

  it('unregisters exactly the batch through the disposer, freeing its keys', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.stay', keys: 'f5' }])
    const dispose = keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+c' }])

    dispose()
    dispose()
    expect(keymap.matches('\x03', 'mayfly.app.quit')).toBe(false)
    expect(keymap.getKeys('mayfly.stay')).toEqual(['f5'])

    // The freed key can be claimed again.
    keymap.register([{ id: 'mayfly.app.interrupt', keys: 'ctrl+c' }])
    expect(keymap.matches('\x03', 'mayfly.app.interrupt')).toBe(true)
  })

  it('dispatches input to handler-carrying actions only, in registration order', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    const calls: string[] = []
    // A handler-less action never participates in dispatch.
    keymap.register([{ id: 'mayfly.input.submit', keys: 'enter' }])
    keymap.register([
      { id: 'mayfly.transcript.toggle', keys: 'ctrl+o', handler: () => calls.push('toggle') },
      { id: 'mayfly.app.palette', keys: 'ctrl+p', handler: () => calls.push('palette') },
    ])

    expect(keymap.dispatch('\r')).toBe(false)
    expect(keymap.dispatch('\x11')).toBe(false)
    expect(calls).toEqual([])

    expect(keymap.dispatch('\x0f')).toBe(true)
    expect(keymap.dispatch('\x10')).toBe(true)
    expect(calls).toEqual(['toggle', 'palette'])
  })

  it('stops at the first matching handler action', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    const calls: string[] = []
    // Two handler actions claiming different keys: dispatch of the later
    // key must not invoke the earlier action.
    keymap.register([{ id: 'mayfly.first', keys: 'ctrl+o', handler: () => calls.push('first') }])
    keymap.register([{ id: 'mayfly.second', keys: 'ctrl+p', handler: () => calls.push('second') }])

    expect(keymap.dispatch('\x10')).toBe(true)
    expect(calls).toEqual(['second'])
  })

  it('rejects a handler action claiming a taken key without committing it', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.app.quit', keys: 'ctrl+o' }])
    const handler = vi.fn()

    expect(() => keymap.register([{ id: 'mayfly.transcript.toggle', keys: 'ctrl+o', handler }]))
      .toThrow(MayflyKeymapError)
    // Zero-commit: the rejected handler action never dispatches.
    expect(keymap.dispatch('\x0f')).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops dispatching an action after its disposer unregisters the batch', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    const handler = vi.fn()
    const dispose = keymap.register([{ id: 'mayfly.transcript.toggle', keys: 'ctrl+o', handler }])

    expect(keymap.dispatch('\x0f')).toBe(true)
    dispose()
    expect(keymap.dispatch('\x0f')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('lists every registered action in registration order across batches', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    expect(keymap.list()).toEqual([])

    keymap.register([{ id: 'mayfly.a', keys: 'ctrl+x', description: 'A' }])
    const handler = () => {}
    keymap.register([
      { id: 'mayfly.b', keys: ['ctrl+o', 'f2'], handler },
      { id: 'mayfly.c', keys: 'f3' },
    ])

    const entry = (id: string, keys: string[], label: string) => ({ id, keys, scope: 'global', label, owner: 'mayfly', defaults: keys, overridden: false })
    expect(keymap.list()).toEqual([
      { ...entry('mayfly.a', ['ctrl+x'], 'A'), description: 'A' },
      entry('mayfly.b', ['ctrl+o', 'f2'], 'mayfly.b'),
      entry('mayfly.c', ['f3'], 'mayfly.c'),
    ])
  })

  it('returns a detached snapshot that cannot reach the registry state', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.a', keys: 'ctrl+x' }])

    const snapshot = keymap.list() as MayflyKeyAction[]
    snapshot.length = 0
    snapshot.push({ id: 'mayfly.injected', keys: ['f9'] })
    expect(keymap.list().map(action => action.id)).toEqual(['mayfly.a'])
    // Mutating a snapshotted key list does not rebind the action.
    const entry = keymap.list()[0]!
    ;(entry.keys as string[]).push('f9')
    expect(keymap.getKeys('mayfly.a')).toEqual(['ctrl+x'])
    expect(keymap.matches('\x1bOP', 'mayfly.a')).toBe(false)
  })

  it('drops a batch from the snapshot once its disposer runs', async () => {
    const ctx = new Context()
    await ctx.plugin(MayflyKeymapService)
    const keymap = ctx.mayflyKeymap
    keymap.register([{ id: 'mayfly.stay', keys: 'f5' }])
    const dispose = keymap.register([{ id: 'mayfly.temp', keys: 'ctrl+t', description: 'Temp' }])
    keymap.register([{ id: 'mayfly.tail', keys: 'f6' }])

    expect(keymap.list().map(action => action.id)).toEqual(['mayfly.stay', 'mayfly.temp', 'mayfly.tail'])
    dispose()
    expect(keymap.list().map(action => action.id)).toEqual(['mayfly.stay', 'mayfly.tail'])
  })

  describe('rebinding', () => {
    async function keymapWithDefaults() {
      const ctx = new Context()
      await ctx.plugin(MayflyKeymapService)
      const keymap = ctx.mayflyKeymap
      keymap.register([
        { id: 'ui.accept', keys: 'enter', scope: 'surface' },
        { id: 'ui.cancel', keys: 'escape' },
        { id: 'ui.copy', keys: 'c', scope: 'surface', description: 'Copy' },
        { id: 'ui.delete', keys: 'x', scope: 'surface', description: 'Delete' },
        { id: 'ui.tab-next', keys: ['alt+right', 'f3'], scope: 'surface' },
        { id: 'mayfly.interaction.steer', keys: 'ctrl+s', scope: 'editor', description: 'Steer' },
        { id: 'mayfly.app.toggle', keys: 'ctrl+o', handler: vi.fn() },
      ])
      return keymap
    }

    it('replaces an action\'s keys: the old key is dead, not an alias', async () => {
      const keymap = await keymapWithDefaults()
      const changes = vi.fn()
      const stop = keymap.subscribe(changes)
      const revision = keymap.revision
      keymap.bind('ui.delete', 'd')
      expect(keymap.getKeys('ui.delete')).toEqual(['d'])
      expect(keymap.matches('d', 'ui.delete')).toBe(true)
      expect(keymap.matches('x', 'ui.delete')).toBe(false)
      expect(keymap.revision).toBe(revision + 1)
      expect(changes).toHaveBeenCalledOnce()
      expect(keymap.list().find(action => action.id === 'ui.delete')).toMatchObject({ keys: ['d'], defaults: ['x'], overridden: true, owner: 'ui', label: 'Delete' })
      keymap.reset('ui.delete')
      keymap.reset('ui.delete')
      expect(keymap.getKeys('ui.delete')).toEqual(['x'])
      expect(changes).toHaveBeenCalledTimes(2)
      stop()
      stop()
      keymap.bind('ui.delete', [])
      expect(keymap.getKeys('ui.delete')).toEqual([])
      expect(changes).toHaveBeenCalledTimes(2)
    })

    it('dispatches a global handler from its rebound key', async () => {
      const keymap = await keymapWithDefaults()
      keymap.bind('mayfly.app.toggle', 'f9')
      expect(keymap.dispatch('\x0f')).toBe(false)
      expect(keymap.dispatch('\x1b[20~')).toBe(true)
    })

    it.each([
      ['Delete', ['d'], 'is not an <owner>.<action> id'],
      ['ui.delete', ['hyper+d'], '"hyper+d" is not a key id'],
      ['ui.delete', ['ctrl+ctrl+d'], 'is not a key id'],
      ['ui.delete', [' '], 'is not a key id'],
      ['ui.delete', ['pagedown'], 'is not a key id'],
      ['ui.cancel', ['ctrl+q'], 'must keep escape: Esc and Enter cannot be unbound'],
      ['ui.accept', ['space'], 'must keep enter'],
      ['ui.copy', ['enter'], 'enter belongs to "ui.accept"'],
      ['mayfly.app.toggle', ['q'], '"q" would type text in the global scope'],
      ['mayfly.interaction.steer', ['shift+s'], 'would type text in the editor scope'],
      ['ui.copy', ['x'], 'key "x" already means "Delete" (ui.delete, owned by ui); rebind that action first'],
      ['ui.copy', ['ctrl+o'], 'already means "mayfly.app.toggle"'],
    ])('refuses binding %s to %j', async (action, keys, message) => {
      const keymap = await keymapWithDefaults()
      expect(() => keymap.bind(action, keys)).toThrow(message)
      expect(keymap.list().some(entry => entry.overridden)).toBe(false)
    })

    it('lets one key mean different actions in different scopes, and keeps Esc and Enter with more keys', async () => {
      const keymap = await keymapWithDefaults()
      keymap.bind('ui.copy', 'ctrl+s')
      keymap.bind('ui.accept', ['enter', 'ctrl+m'])
      keymap.bind('ui.cancel', ['escape', 'ctrl+q'])
      expect(keymap.getKeys('ui.copy')).toEqual(['ctrl+s'])
      expect(keymap.getKeys('mayfly.interaction.steer')).toEqual(['ctrl+s'])
      expect(() => keymap.bind('mayfly.interaction.steer', 'ctrl+q')).toThrow('already means "ui.cancel"')
    })

    it('offers component actions seen in admitted nodes, and saved overrides for actions not loaded', async () => {
      const keymap = await keymapWithDefaults()
      keymap.see([{ id: 'demo-plugin.install', label: 'Install', keys: ['i'] }, { id: 'ui.copy', label: 'Copy row', keys: ['c'] }])
      keymap.see([{ id: 'demo-plugin.install', label: 'Install plugin', keys: ['i'] }])
      expect(keymap.getKeys('demo-plugin.install')).toEqual(['i'])
      expect(keymap.resolve('demo-plugin.install', ['j'])).toEqual(['j'])
      expect(() => keymap.bind('demo-plugin.remove', 'i')).toThrow('already means "Install plugin" (demo-plugin.install, owned by demo-plugin)')
      keymap.bind('demo-plugin.install', 'p')
      expect(keymap.resolve('demo-plugin.install', ['j'])).toEqual(['p'])
      keymap.bind('other-plugin.sync', 'ctrl+y', 'Sync now')
      keymap.bind('third-plugin.go', 'ctrl+g')
      expect(keymap.list().slice(-3)).toEqual([
        { id: 'demo-plugin.install', keys: ['p'], scope: 'surface', label: 'Install plugin', owner: 'demo-plugin', defaults: ['i'], overridden: true },
        { id: 'other-plugin.sync', keys: ['ctrl+y'], scope: 'surface', label: 'Sync now', owner: 'other-plugin', defaults: [], overridden: true },
        { id: 'third-plugin.go', keys: ['ctrl+g'], scope: 'surface', label: 'third-plugin.go', owner: 'third-plugin', defaults: [], overridden: true },
      ])
      keymap.resetAll()
      keymap.resetAll()
      expect(keymap.list().map(action => action.id).slice(-1)).toEqual(['demo-plugin.install'])
    })

    it('applies a saved document at once, skipping the entries it must refuse', async () => {
      const keymap = await keymapWithDefaults()
      const changes = vi.fn()
      keymap.subscribe(changes)
      const refused = keymap.applyOverrides({
        'ui.delete': { keys: ['d'] },
        'ui.copy': { keys: ['d'] },
        'demo-plugin.pin': { keys: ['p'], label: 'Pin' },
      })
      expect(refused.map(error => [error.code, error.message])).toEqual([['KEY_CONFLICT', expect.stringContaining('key "d" already means "Delete"')]])
      expect(keymap.getKeys('ui.delete')).toEqual(['d'])
      expect(keymap.list().find(action => action.id === 'demo-plugin.pin')).toMatchObject({ label: 'Pin', keys: ['p'] })
      expect(changes).toHaveBeenCalledOnce()
      keymap.applyOverrides({ 'ui.delete': { keys: ['d'] }, 'demo-plugin.pin': { keys: ['p'], label: 'Pin' } })
      expect(changes).toHaveBeenCalledOnce()
      keymap.applyOverrides({})
      expect(keymap.getKeys('ui.delete')).toEqual(['x'])
      expect(changes).toHaveBeenCalledTimes(2)
    })

    it('leads with the plain key once a setting or the first F2-F5 press asks for it', async () => {
      const keymap = await keymapWithDefaults()
      const changes = vi.fn()
      keymap.subscribe(changes)
      expect(keymap.getKeys('ui.tab-next')).toEqual(['alt+right', 'f3'])
      keymap.notePlainKey('\x1b[1;3C')
      expect(keymap.preferPlain).toBe(false)
      keymap.setPreferPlain(false)
      keymap.setPreferPlain(true)
      expect(keymap.getKeys('ui.tab-next')).toEqual(['f3', 'alt+right'])
      keymap.notePlainKey('\x1bOQ')
      keymap.setPreferPlain(false)
      expect(keymap.preferPlain).toBe(true)
      expect(changes).toHaveBeenCalledOnce()
      keymap.notePlainKey('\x1b[15~')
      expect(changes).toHaveBeenCalledOnce()
      keymap.setPreferPlain(true)
      expect(changes).toHaveBeenCalledOnce()
    })

    it('learns plain keys for the session from F2 alone', async () => {
      const keymap = await keymapWithDefaults()
      keymap.notePlainKey('\x1bOQ')
      expect(keymap.preferPlain).toBe(true)
      expect(keymap.getKeys('ui.tab-next')).toEqual(['f3', 'alt+right'])
    })
  })
})
