/** Snapshot-service API package tests.
 * @module @ephemeral-ai/mayfly-ui/tests/provider
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/provider.ts'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('@ephemeral-ai/mayfly-ui provider', () => {
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

  it('uses null pane/status nodes as absence and increments every explicit set', async () => {
    const ctx = new Context()
    const owner = await ctx.plugin({ name: 'api-owner', apply })
    const pane = ctx.mayflyPanes.register({ id: 'pane.optional', placement: 'bottom' })
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
    const later = ctx.mayflyOverlays.open({ id: 'overlay.later', capturing: true }, { kind: 'text', content: 'open' })
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
    alpha.set({ hint: 'second', diagnostics: [{ id: 'warning', message: 'check' }] })
    expect(ctx.mayflyEditorExtensions.list().map(entry => entry.id)).toEqual(['extension.alpha', 'extension.later'])
    expect(ctx.mayflyEditorExtensions.list()[0]).toMatchObject({
      revision: 1,
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
