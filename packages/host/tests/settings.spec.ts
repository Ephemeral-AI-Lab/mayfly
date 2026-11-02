/** Native Host preference defaults, validation, and Fiber-owned settings registration. @module */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../src/settings.ts'

function resolve(raw: Record<string, unknown> = {}): Record<string, unknown> {
  const values = Config(raw) as Record<string, { get(): unknown }>
  return Object.fromEntries(Object.entries(values).map(([key, cell]) => [key, cell.get()]))
}

describe('Host Mayfly settings', () => {
  it('keeps frontend presentation defaults in the native volatile namespace', () => {
    expect(name).toBe('mayfly-settings')
    expect(inject).toEqual(['settings'])
    expect(resolve()).toMatchObject({
      theme: 'dark', language: 'system', startup: 'conversation', transcriptView: 'standard',
      keybindings: {}, prices: {}, windowTurns: 15, quietHints: 'full', reducedMotion: false,
    })
    expect(resolve({ theme: 'retired-theme' }).theme).toBe('dark')
    expect(resolve({ theme: 'auto', language: 'zh', startup: 'splash' })).toMatchObject({ theme: 'auto', language: 'zh', startup: 'splash' })
    expect(resolve({
      prices: { 'provider/model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0.5 } },
      keybindings: { 'editor.submit': { keys: ['ctrl+enter'], label: 'Send' } },
    })).toMatchObject({
      prices: { 'provider/model': { input: 1, output: 2, currency: 'USD' } },
      keybindings: { 'editor.submit': { keys: ['ctrl+enter'], label: 'Send' } },
    })
    expect(() => resolve({ prices: { broken: { input: -1, output: 1 } } })).toThrow()
  })

  it('registers and releases each native settings page on its exact plugin Fiber', async () => {
    const ctx = new Context()
    const active = new Set<unknown>()
    const configure = vi.fn((_config: unknown, fiber: unknown) => {
      active.add(fiber)
      return () => { active.delete(fiber) }
    })
    ctx.provide('settings', { configure } as never)
    try {
      const first = await ctx.plugin({ name, inject, apply })
      expect(configure).toHaveBeenCalledWith({ auto: true }, expect.anything())
      expect(active.size).toBe(1)
      await first.dispose()
      expect(active.size).toBe(0)
      const second = await ctx.plugin({ name, inject, apply })
      expect(active.size).toBe(1)
      await second.dispose()
      expect(active.size).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })
})
