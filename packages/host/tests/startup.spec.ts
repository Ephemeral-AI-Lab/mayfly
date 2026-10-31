/**
 * Decision tests for the startup URL printer: token attachment, one print per
 * process, and the loader wait.
 * @module
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, authenticatedMayflyHostUrl, inject, name } from '../src/startup.ts'

/** Every line the plugin printed in this test. */
const printed: string[] = []

beforeEach(() => {
  printed.length = 0
  // Re-armed per test: a module-level spy would be restored by the first
  // test's teardown and silently stop capturing.
  vi.spyOn(console, 'log').mockImplementation((line: string): void => { printed.push(line) })
})

/** A context answering one advertised URL and an optional loader. */
function ctx(overrides: Partial<{ readonly loader: { await(): Promise<void> } | undefined }> = {}): Context {
  return {
    webApp: { getAdvertisedUrl: (): string => 'http://127.0.0.1:3080' },
    connection: { authenticatedUrl: (url: string): string => `${url}/?token=sekret` },
    effect: (fn: () => () => void): (() => void) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: (key: string): unknown => key === 'loader' ? overrides.loader : undefined,
  } as unknown as Context
}

describe('mayfly-host-startup', () => {
  it('declares its name and the web/connection services', () => {
    expect(name).toBe('mayfly-host-startup')
    expect(inject).toEqual(['webApp', 'connection'])
  })

  it('attaches the process token to the advertised URL', () => {
    expect(authenticatedMayflyHostUrl(ctx())).toBe('http://127.0.0.1:3080/?token=sekret')
  })

  it('prints the authenticated URL once, after the loader settles', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await apply(ctx({ loader: { await: (): Promise<void> => gate } }))
    // Nothing before settlement.
    expect(printed).toEqual([])
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(printed).toEqual(['mayfly host: http://127.0.0.1:3080/?token=sekret'])
  })

  it('prints immediately in a hand-built tree with no loader', async () => {
    await apply(ctx())
    expect(printed).toEqual(['mayfly host: http://127.0.0.1:3080/?token=sekret'])
  })
})
