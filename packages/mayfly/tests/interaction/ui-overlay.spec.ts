/** Ordinary overlay signal and Fiber cleanup.
 * @module @ephemeral-ai/mayfly/tests/interaction/ui-overlay
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import { openUiOverlay } from '../../src/interaction/ui-overlay.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('openUiOverlay', () => {
  it('requires a registry and rejects an already aborted caller', async () => {
    const missing = new Context()
    contexts.push(missing)
    expect(() => openUiOverlay(missing, { id: 'missing' }, { kind: 'text', content: 'body' }, { reopen: 'replace' })).toThrow('Mayfly overlays are unavailable')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const aborted = new AbortController()
    aborted.abort()
    expect(() => openUiOverlay(ctx, { id: 'aborted' }, { kind: 'text', content: 'body' }, { signal: aborted.signal, reopen: 'replace' })).toThrow()
  })

  it('closes on abort and unregisters its listener', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const owner = new AbortController()
    const handle = openUiOverlay(ctx, { id: 'owned' }, { kind: 'text', content: 'body' }, { signal: owner.signal, reopen: 'replace' })
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
    owner.abort()
    expect(handle.closed).toBe(true)
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('cleans a manually closed overlay without a caller signal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const handle = openUiOverlay(ctx, { id: 'manual' }, { kind: 'text', content: 'body' }, { reopen: 'replace' })
    handle.close()
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('cleans an overlay closed by an initial-publication listener', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'synchronous') ctx.mayflyOverlays.close('synchronous') })
    const handle = openUiOverlay(ctx, { id: 'synchronous' }, { kind: 'text', content: 'body' }, { reopen: 'replace' })
    expect(handle.closed).toBe(true)
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('focuses the live same-id overlay under the focus policy', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const first = openUiOverlay(ctx, { id: 'picker' }, { kind: 'text', content: 'one' }, { reopen: 'focus' })
    const second = openUiOverlay(ctx, { id: 'picker' }, { kind: 'text', content: 'two' }, { reopen: 'focus' })
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(ctx.mayflyOverlays.list()[0]!.focusRevision).toBeGreaterThan(0)
  })

  it('replaces the live same-id overlay under the replace policy', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const first = openUiOverlay(ctx, { id: 'picker' }, { kind: 'text', content: 'one' }, { reopen: 'replace' })
    const second = openUiOverlay(ctx, { id: 'picker' }, { kind: 'text', content: 'two' }, { reopen: 'replace' })
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('runs onClosed when the overlay is removed and on fiber unload', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const onClosed = vi.fn()
    const handle = openUiOverlay(ctx, { id: 'watched' }, { kind: 'text', content: 'body' }, { reopen: 'replace', onClosed })
    handle.close()
    expect(onClosed).toHaveBeenCalledTimes(1)
    const child = await ctx.plugin({ name: 'watched-owner', apply: scope => { openUiOverlay(scope, { id: 'unloaded' }, { kind: 'text', content: 'body' }, { reopen: 'replace', onClosed }) } })
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['unloaded'])
    await child.dispose()
    expect(onClosed).toHaveBeenCalledTimes(2)
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })
})
