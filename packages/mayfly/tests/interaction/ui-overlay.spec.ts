/** Ordinary overlay signal and Fiber cleanup.
 * @module @ephemeral-ai/mayfly/tests/interaction/ui-overlay
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import { openUiOverlay } from '../../src/interaction/ui-overlay.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('openUiOverlay', () => {
  it('requires a registry and rejects an already aborted caller', async () => {
    const missing = new Context()
    contexts.push(missing)
    expect(() => openUiOverlay(missing, { id: 'missing' }, { kind: 'text', content: 'body' })).toThrow('Mayfly overlays are unavailable')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const aborted = new AbortController()
    aborted.abort()
    expect(() => openUiOverlay(ctx, { id: 'aborted' }, { kind: 'text', content: 'body' }, aborted.signal)).toThrow()
  })

  it('closes on abort and unregisters its listener', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const owner = new AbortController()
    const handle = openUiOverlay(ctx, { id: 'owned' }, { kind: 'text', content: 'body' }, owner.signal)
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
    owner.abort()
    expect(handle.closed).toBe(true)
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('cleans a manually closed overlay without a caller signal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const handle = openUiOverlay(ctx, { id: 'manual' }, { kind: 'text', content: 'body' })
    handle.close()
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('cleans an overlay closed by an initial-publication listener', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'synchronous') ctx.mayflyOverlays.close('synchronous') })
    const handle = openUiOverlay(ctx, { id: 'synchronous' }, { kind: 'text', content: 'body' })
    expect(handle.closed).toBe(true)
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })
})
