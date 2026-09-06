/** Snapshot-service API package tests.
 * @module @ephemeral-ai/mayfly-ui/tests/provider
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/provider.ts'
import type { MayflyEditorDecoration, MayflyStatusNode } from '../src/contracts.ts'

const packageDir = dirname(fileURLToPath(import.meta.url))

function registryCase(ctx: Context, kind: 'pane' | 'status' | 'overlay' | 'editor') {
  const register = (definition: { id: string, placement: 'bottom' }, payload: MayflyStatusNode & MayflyEditorDecoration) => {
    switch (kind) {
      case 'pane': return ctx.mayflyPanes.register(definition, payload)
      case 'status': return ctx.mayflyStatus.register(definition, payload)
      case 'overlay': return ctx.mayflyOverlays.open(definition, payload)
      case 'editor': return ctx.mayflyEditorExtensions.register(definition, payload)
    }
  }
  const registry = kind === 'pane' ? ctx.mayflyPanes : kind === 'status' ? ctx.mayflyStatus : kind === 'overlay' ? ctx.mayflyOverlays : ctx.mayflyEditorExtensions
  return { register, registry }
}

describe('@ephemeral-ai/mayfly-ui provider', () => {
  it.each(['pane', 'status', 'overlay', 'editor'] as const)('keeps %s identity and cleanup isolated from caller mutations', async kind => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const { register, registry } = registryCase(ctx, kind)
    const neighbor = register({ id: 'test.neighbor', placement: 'bottom' }, { kind: 'text', content: 'neighbor', hint: 'neighbor' })
    const deltas = vi.fn()
    registry.subscribe(deltas)
    let handle!: ReturnType<typeof register>
    const definition = { id: 'test.original', placement: 'bottom' as const }
    const consumer = await ctx.plugin({
      name: 'mutable-owner',
      inject: ['mayflyPanes', 'mayflyStatus', 'mayflyOverlays', 'mayflyEditorExtensions'],
      apply(pluginCtx: Context) {
        handle = registryCase(pluginCtx, kind).register(definition, { kind: 'text', content: 'first', hint: 'first' })
      },
    })
    for (const id of ['test.unused', 'test.neighbor']) {
      definition.id = id
      handle.set({ kind: 'text', content: id, hint: id })
      expect(registry.list().map(entry => [entry.id, entry.definition.id])).toEqual([
        ['test.neighbor', 'test.neighbor'], ['test.original', 'test.original'],
      ])
      expect(registry.list().find(entry => entry.id === 'test.neighbor')?.revision).toBe(0)
    }
    await consumer.dispose()
    expect(registry.list().map(entry => entry.id)).toEqual(['test.neighbor'])
    expect(deltas).toHaveBeenLastCalledWith({ kind: 'remove', id: 'test.original', revision: 3 })
    const count = deltas.mock.calls.length
    handle.dispose()
    handle.set({ kind: 'text', content: 'late' })
    expect(deltas).toHaveBeenCalledTimes(count)
    if (kind === 'overlay') {
      expect(ctx.mayflyOverlays.close('test.original')).toBe(false)
      expect(ctx.mayflyOverlays.close('test.neighbor')).toBe(true)
    } else neighbor.dispose()
    await owner.dispose()
  })

  it.each(['pane', 'status', 'overlay', 'editor'] as const)('makes failed %s admission atomic without invoking getters', async kind => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const { register, registry } = registryCase(ctx, kind)
    const getter = vi.fn(() => 'test.failed')
    const definition = Object.defineProperty({ placement: 'bottom' as const }, 'id', { enumerable: true, get: getter }) as { id: string, placement: 'bottom' }
    const bad = Object.defineProperty({ kind: 'text' as const }, 'content', { enumerable: true, get: getter }) as MayflyStatusNode
    const cyclic = { kind: 'text' as const, content: 'cycle', self: undefined as unknown }
    cyclic.self = cyclic
    const deltas = vi.fn()
    registry.subscribe(deltas)
    const consumer = await ctx.plugin({
      name: 'failed-owner',
      inject: ['mayflyPanes', 'mayflyStatus', 'mayflyOverlays', 'mayflyEditorExtensions'],
      apply(pluginCtx: Context) {
        const scoped = registryCase(pluginCtx, kind)
        expect(() => scoped.register(definition, { kind: 'text', content: 'safe' })).toThrow('accessors')
        expect(() => scoped.register({ id: 'test.failed', placement: 'bottom' }, bad)).toThrow('accessors')
        expect(() => scoped.register({ id: 'test.failed', placement: 'bottom' }, cyclic)).toThrow('cycles')
      },
    })
    expect(deltas).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
    const good = register({ id: 'test.failed', placement: 'bottom' }, { kind: 'text', content: 'safe', hint: 'safe' })
    const before = registry.list()[0]
    expect(() => good.set(bad)).toThrow('accessors')
    const update = Object.defineProperty({}, 'eventRevision', { enumerable: true, get: getter })
    expect(() => good.set({ kind: 'text', content: 'rejected' }, update)).toThrow('accessors')
    expect(good.revision).toBe(0)
    expect(registry.list()[0]).toBe(before)
    await consumer.dispose()
    expect(registry.list()[0]).toBe(before)
    expect(deltas).toHaveBeenCalledOnce()
    expect(getter).not.toHaveBeenCalled()
    good.dispose()
    await owner.dispose()
  })

  it('provides four direct Fiber-owned registries from an explicit provider entry', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin({ name: 'api-test', apply })
    expect(ctx.mayflyPanes).toBeDefined()
    expect(ctx.mayflyStatus).toBeDefined()
    expect(ctx.mayflyOverlays).toBeDefined()
    expect(ctx.mayflyEditorExtensions).toBeDefined()
    const manifest = JSON.parse(readFileSync(join(packageDir, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
    }
    expect(Object.keys(manifest.exports)).toEqual(['.', './provider', './package.json'])
    expect(manifest.files).toEqual(['lib/**/*'])
    await fiber.dispose()
  })

  it('publishes pane snapshots and removes them with the calling Fiber', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    expect(() => ctx.mayflyPanes.register(null as never)).toThrow('definition')
    expect(() => ctx.mayflyPanes.register({ id: 1 as never, placement: 'bottom' })).toThrow('string')
    const deltas = vi.fn()
    const off = ctx.mayflyPanes.subscribe(deltas)
    const consumer = await ctx.plugin({
      name: 'pane-consumer',
      inject: ['mayflyPanes'],
      apply(pluginCtx: Context) {
        const pane = pluginCtx.mayflyPanes.register(
          { id: 'test.pane', placement: 'bottom', priority: 10 },
          { kind: 'text', content: 'first' },
        )
        pane.set({ kind: 'text', content: 'second' })
      },
    })
    expect(ctx.mayflyPanes.list()[0]).toMatchObject({
      id: 'test.pane',
      revision: 1,
      definition: { placement: 'bottom', priority: 10 },
      node: { kind: 'text', content: 'second' },
    })
    expect(deltas).toHaveBeenCalledTimes(2)
    await consumer.dispose()
    expect(ctx.mayflyPanes.list()).toEqual([])
    expect(deltas).toHaveBeenLastCalledWith({ kind: 'remove', id: 'test.pane', revision: 2 })
    off()
    await owner.dispose()
  })

  it('loads pane snapshots through a cancellable service-owned provider', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const signals: AbortSignal[] = []
    const pane = ctx.mayflyPanes.register({
      id: 'test.loaded-pane',
      placement: 'bottom',
      load: async signal => {
        signals.push(signal)
        return { kind: 'text', content: 'loaded' }
      },
    })
    await vi.waitFor(() => expect(ctx.mayflyPanes.list()[0]?.node).toEqual({ kind: 'text', content: 'loaded' }))
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
    await pane.refresh()
    expect(ctx.mayflyPanes.list()[0]?.revision).toBe(2)
    await owner.dispose()
  })

  it('orders pane/status snapshots and rejects duplicate or invalid ids', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    expect(() => ctx.mayflyPanes.register({ id: 'Bad Pane', placement: 'bottom' })).toThrow('invalid')
    ctx.mayflyPanes.register({ id: 'pane.beta', placement: 'bottom', priority: 10 })
    ctx.mayflyPanes.register({ id: 'pane.alpha', placement: 'bottom', priority: 10 })
    expect(() => ctx.mayflyPanes.register({ id: 'pane.alpha', placement: 'right' })).toThrow('already registered')
    expect(ctx.mayflyPanes.list().map(entry => entry.id)).toEqual(['pane.alpha', 'pane.beta'])

    ctx.mayflyStatus.register({ id: 'status.later', priority: 20 }, { kind: 'text', content: 'later' })
    ctx.mayflyStatus.register({ id: 'status.beta', priority: 10 }, { kind: 'text', content: 'beta' })
    ctx.mayflyStatus.register({ id: 'status.alpha', priority: 10 }, { kind: 'text', content: 'alpha' })
    expect(() => ctx.mayflyStatus.register({ id: 'status.alpha' })).toThrow('already registered')
    expect(() => ctx.mayflyStatus.register({ id: 'Bad Status' })).toThrow('invalid')
    expect(ctx.mayflyStatus.list().map(entry => entry.id)).toEqual(['status.alpha', 'status.beta', 'status.later'])
    await owner.dispose()
  })

  it('rejects malformed definitions before publishing a registry entry', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-placement', placement: 'floating' as never })).toThrow('placement')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-size', placement: 'bottom', size: { min: 8, max: 2 } })).toThrow('must not exceed')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-preferred-low', placement: 'bottom', size: { min: 8, preferred: 2 } })).toThrow('below min')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-preferred-high', placement: 'bottom', size: { max: 2, preferred: 8 } })).toThrow('exceed max')
    expect(() => ctx.mayflyStatus.register({ id: 'status.bad-row', row: 3 as never })).toThrow('row')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-priority', placement: 'bottom', size: { min: -1 } as never })).toThrow('non-negative')
    expect(() => ctx.mayflyStatus.register({ id: 'status.bad-priority', priority: 1.5 })).toThrow('safe integer')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-title', placement: 'bottom', title: 1 as never })).toThrow('title')
    expect(() => ctx.mayflyPanes.register({ id: 'pane.bad-narrow', placement: 'bottom', narrow: 'side' as never })).toThrow('narrow')
    expect(() => ctx.mayflyStatus.register({ id: 'status.bad-band', band: 'outer' as never })).toThrow('band')
    expect(() => ctx.mayflyStatus.register({ id: 'status.bad-overflow', overflow: 'scroll' as never })).toThrow('overflow')
    expect(() => ctx.mayflyOverlays.open({ id: 'overlay.bad-width', width: '120%' as never }, { kind: 'text', content: 'bad' })).toThrow('width')
    expect(() => ctx.mayflyOverlays.open({ id: 'overlay.bad-anchor', anchor: 'diagonal' as never }, { kind: 'text', content: 'bad' })).toThrow('anchor')
    expect(() => ctx.mayflyOverlays.open({ id: 'overlay.bad-capturing', capturing: 'yes' as never }, { kind: 'text', content: 'bad' })).toThrow('capturing')
    expect(() => ctx.mayflyOverlays.open({ id: 'overlay.bad-min-width', minWidth: -1 }, { kind: 'text', content: 'bad' })).toThrow('non-negative')
    expect(() => ctx.mayflyEditorExtensions.register({ id: 'extension.bad-callback', complete: true as never })).toThrow('function')
    expect(ctx.mayflyPanes.list()).toEqual([])
    expect(ctx.mayflyStatus.list()).toEqual([])
    expect(ctx.mayflyOverlays.list()).toEqual([])
    expect(ctx.mayflyEditorExtensions.list()).toEqual([])
    await owner.dispose()
  })

  it('uses null pane/status nodes as absence and increments every explicit set', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const pane = ctx.mayflyPanes.register({ id: 'pane.optional', placement: 'bottom', size: { min: 1, max: 10, preferred: 5 } })
    const status = ctx.mayflyStatus.register({ id: 'status.optional' })
    expect(ctx.mayflyPanes.list()[0]?.node).toBeNull()
    expect(ctx.mayflyStatus.list()[0]?.node).toBeNull()
    pane.set({ kind: 'text', content: 'visible' }, { eventRevision: 7 })
    expect(ctx.mayflyPanes.list()[0]?.eventRevision).toBe(7)
    pane.set(null)
    status.set({ kind: 'text', content: 'ready' })
    expect(pane.revision).toBe(2)
    expect(status.revision).toBe(1)
    expect(ctx.mayflyPanes.list()[0]?.node).toBeNull()
    await owner.dispose()
  })

  it('opens, updates, focuses, hides, shows, and closes overlays in opening order', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const later = ctx.mayflyOverlays.open({ id: 'overlay.later', capturing: true, width: '60%', maxHeight: 10 }, { kind: 'text', content: 'open' })
    const earlier = ctx.mayflyOverlays.open({ id: 'overlay.earlier' }, { kind: 'text', content: 'second' })
    expect(() => ctx.mayflyOverlays.open({ id: 'overlay.later' }, { kind: 'text', content: 'duplicate' })).toThrow('already open')
    expect(() => ctx.mayflyOverlays.open({ id: 'Bad Overlay' }, { kind: 'text', content: 'invalid' })).toThrow('invalid')
    later.set({ kind: 'text', content: 'updated' }, { eventRevision: 4 })
    expect(later.revision).toBe(1)
    expect(ctx.mayflyOverlays.list()[0]?.eventRevision).toBe(4)
    later.focus()
    later.hide()
    later.hide()
    expect(ctx.mayflyOverlays.list()[0]).toMatchObject({ id: 'overlay.later', revision: 2, focusRevision: 1, hidden: true })
    later.show()
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['overlay.later', 'overlay.earlier'])
    expect(ctx.mayflyOverlays.close('overlay.later')).toBe(true)
    expect(later.closed).toBe(true)
    later.set({ kind: 'text', content: 'ignored' })
    later.focus()
    later.hide()
    later.show()
    later.close()
    expect(ctx.mayflyOverlays.close('overlay.later')).toBe(false)
    earlier.close()
    await owner.dispose()
  })

  it('loads overlay snapshots through a cancellable provider', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'overlay-owner', apply })
    let signal: AbortSignal | undefined
    const overlay = ctx.mayflyOverlays.open({
      id: 'overlay.loaded',
      load: async current => {
        signal = current
        return { kind: 'text', content: 'loaded' }
      },
    }, { kind: 'text', content: 'initial' })
    await vi.waitFor(() => expect(ctx.mayflyOverlays.list()[0]?.node).toEqual({ kind: 'text', content: 'loaded' }))
    expect(signal?.aborted).toBe(true)
    overlay.close()
    expect(signal?.aborted).toBe(true)
    await owner.dispose()
  })

  it('publishes editor definitions separately from mutable decorations', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const complete = vi.fn(() => [])
    const later = ctx.mayflyEditorExtensions.register({ id: 'extension.later', priority: 20, complete })
    const alpha = ctx.mayflyEditorExtensions.register(
      { id: 'extension.alpha', priority: 10 },
      { hint: 'first' },
    )
    expect(() => ctx.mayflyEditorExtensions.register({ id: 'extension.alpha' })).toThrow('already registered')
    expect(() => ctx.mayflyEditorExtensions.register({ id: 'Bad Extension' })).toThrow('invalid')
    alpha.set({ hint: 'second', diagnostics: [{ id: 'warning', message: 'check' }] }, { eventRevision: 8 })
    expect(ctx.mayflyEditorExtensions.list().map(entry => entry.id)).toEqual(['extension.alpha', 'extension.later'])
    expect(ctx.mayflyEditorExtensions.list()[0]).toMatchObject({
      revision: 1,
      eventRevision: 8,
      definition: { id: 'extension.alpha' },
      decoration: { hint: 'second' },
    })
    expect(ctx.mayflyEditorExtensions.list()[1]?.definition.complete).toBe(complete)
    later.dispose()
    alpha.dispose()
    await owner.dispose()
  })

  it('clones and freezes snapshots and rejects cycles without mutating caller data', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const node = { kind: 'text' as const, content: 'original' }
    const pane = ctx.mayflyPanes.register({ id: 'pane.freeze', placement: 'bottom' }, node)
    node.content = 'mutated'
    const snapshot = ctx.mayflyPanes.list()[0]!
    expect(snapshot.node).toEqual({ kind: 'text', content: 'original' })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.node)).toBe(true)
    const cyclic = { kind: 'text', content: 'cycle' } as { kind: 'text', content: string, self?: unknown }
    cyclic.self = cyclic
    const revision = pane.revision
    expect(() => pane.set(cyclic as never)).toThrow('must not contain cycles')
    expect(pane.revision).toBe(revision)
    await owner.dispose()
  })

  it('replays current entries to late subscribers and keeps disposal idempotent', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const handle = ctx.mayflyStatus.register({ id: 'status.ready' }, { kind: 'text', content: 'ready' })
    const listener = vi.fn()
    const off = ctx.mayflyStatus.subscribe(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'upsert' }))
    handle.dispose()
    handle.dispose()
    handle.set({ kind: 'text', content: 'ignored' })
    off()
    expect(ctx.mayflyStatus.list()).toEqual([])
    await owner.dispose()
  })
})
