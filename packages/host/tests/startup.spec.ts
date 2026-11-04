/**
 * Decision tests for the startup URL printer: token attachment, one print per
 * process, and the loader wait.
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** A context answering one advertised URL and an optional loader. */
function ctx(overrides: Partial<{ readonly loader: { await(): Promise<void> } | undefined, readonly disposers: (() => void)[] }> = {}): Context {
  return {
    webApp: { getAdvertisedUrl: (): string => 'http://127.0.0.1:3080' },
    connection: { authenticatedUrl: (url: string): string => `${url}/?token=sekret` },
    effect: (fn: () => () => void): (() => void) => {
      const dispose = fn()
      overrides.disposers?.push(dispose)
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

  it('does not announce readiness after its owning Fiber unloads during startup', async () => {
    const gate = Promise.withResolvers<void>()
    const disposers: (() => void)[] = []
    apply(ctx({ loader: { await: () => gate.promise }, disposers }))
    disposers[0]!()
    gate.resolve()
    await new Promise(resolve => setImmediate(resolve))
    expect(printed).toEqual([])
  })

  it('leaves failed native startup diagnostics to Loader and prints no authenticated URL', async () => {
    const gate = Promise.withResolvers<void>()
    apply(ctx({ loader: { await: () => gate.promise } }))
    gate.reject(new Error('native profile did not settle'))
    await new Promise(resolve => setImmediate(resolve))
    expect(printed).toEqual([])
  })

  it('hands managed readiness to its parent and requests native exit over IPC', () => {
    vi.stubEnv('MAYFLY_MANAGED_HOST', '1')
    const send = vi.spyOn(process, 'send').mockImplementation(() => true)
    const callbacks = new Map<string, (...args: unknown[]) => void>()
    const originalOn = process.on.bind(process)
    vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'message' || event === 'disconnect') { callbacks.set(event, fn); return process }
      return originalOn(event, fn)
    }) as typeof process.on)
    const exit = vi.fn()
    const context = ctx()
    context.get = vi.fn((key: string) => key === 'appExit' ? exit : undefined) as typeof context.get
    apply(context)
    expect(send).toHaveBeenCalledWith({ type: 'mayfly-ready', url: 'http://127.0.0.1:3080/?token=sekret' })
    expect(printed).toEqual([])
    for (const message of [null, 'stop', {}, { type: 'other' }]) callbacks.get('message')!(message)
    expect(exit).not.toHaveBeenCalled()
    callbacks.get('message')!({ type: 'mayfly-stop' })
    callbacks.get('disconnect')!()
    expect(exit).toHaveBeenCalledTimes(2)
  })

  it('retires IPC callbacks on unload and handles a disconnected parent before readiness', () => {
    vi.stubEnv('MAYFLY_MANAGED_HOST', '1')
    const send = vi.spyOn(process, 'send').mockImplementation(() => true)
    const connected = process.connected
    Object.defineProperty(process, 'connected', { value: false, configurable: true, writable: true })
    const disposers: (() => void)[] = []
    try {
      const context = ctx({ disposers })
      apply(context)
      expect(send).not.toHaveBeenCalled()
      const callback = process.listeners('message').at(-1)!
      callback.call(process, { type: 'mayfly-stop' }, undefined)
      disposers[0]!()
      callback.call(process, { type: 'mayfly-stop' }, undefined)
      expect(process.listeners('message')).not.toContain(callback)
    } finally { Object.defineProperty(process, 'connected', { value: connected, configurable: true, writable: true }) }
  })
})
