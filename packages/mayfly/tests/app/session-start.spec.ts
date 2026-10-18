/** Lazy session start: the boot signal and the one shared creation promise.
 * @module @ephemeral-ai/mayfly/tests/app/session-start
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflySessionStartService } from '../../src/app/session-start.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function service(start = vi.fn(async () => ({ id: 'agent' } as unknown as Agent))) {
  const ctx = new Context(); contexts.push(ctx)
  return { ctx, start, startService: new MayflySessionStartService(ctx, start) }
}

describe('MayflySessionStartService', () => {
  it('delegates ensure to the app driver', async () => {
    const { start, startService } = service()
    const agent = await startService.ensure()
    expect(agent).toEqual({ id: 'agent' })
    expect(start).toHaveBeenCalledOnce()
  })

  it('runs listeners queued before boot exactly once and releases them', () => {
    const { startService } = service()
    const listener = vi.fn()
    startService.onBooted(listener)
    expect(listener).not.toHaveBeenCalled()
    startService.markBooted()
    expect(listener).toHaveBeenCalledOnce()
    startService.markBooted()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('runs a listener registered after boot at once and returns a no-op disposer', () => {
    const { startService } = service()
    startService.markBooted()
    const listener = vi.fn()
    const off = startService.onBooted(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(off()).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('removes a queued listener through its disposer', () => {
    const { startService } = service()
    const listener = vi.fn()
    const off = startService.onBooted(listener)
    off()
    startService.markBooted()
    expect(listener).not.toHaveBeenCalled()
  })

  it('clears queued listeners when the owning tree unloads', async () => {
    const { ctx, startService } = service()
    const listener = vi.fn()
    startService.onBooted(listener)
    await ctx.fiber.dispose()
    startService.markBooted()
    expect(listener).not.toHaveBeenCalled()
  })
})
