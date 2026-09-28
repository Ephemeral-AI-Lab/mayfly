/** User-level provider store: home patch I/O, native mirror, and migration.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-store
 */
import { Context } from '@deepseek-ai/cordis'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { updaterInternals } from '../../src/interaction/updater/io.ts'
import {
  migrateProvidersToHome,
  persistProviders,
  providerOpsTarget,
  providerStoreInternals,
  readHomeProviders,
  restoreHome,
  scheduleProviderMigration,
  writeHomeProviders,
} from '../../src/interaction/provider-store.ts'

registerTempDirCleanup()

const REAL_STORE = { ...providerStoreInternals }
const REAL_ENV = updaterInternals.env
const REAL_HOMEDIR = updaterInternals.homedir
afterEach(() => {
  Object.assign(providerStoreInternals, REAL_STORE)
  updaterInternals.env = REAL_ENV
  updaterInternals.homedir = REAL_HOMEDIR
})

const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const tempFile = (): string => join(mkdtempTracked('mayfly-provider-store-'), 'cordis.patch.yml')

function descriptor(value: unknown, revision = 0) {
  return { ns: 'llm-pi-ai', autoGenerate: true, schema: {}, value, revision, applies: 'live' as const }
}

function fakeSettings(value: unknown, mutate: (ns: string, ops: unknown, expected?: number) => Promise<void> = async () => {}): SettingsForms {
  return { describe: () => [descriptor(value)], mutate } as unknown as SettingsForms
}

describe('provider store internals', () => {
  it('resolves the configured and default harness homes', () => {
    const home = mkdtempTracked('mayfly-provider-home-')
    updaterInternals.env = { DSH_HOME: home }
    expect(providerStoreInternals.homePatchPath()).toBe(join(home, 'cordis.patch.yml'))
    updaterInternals.env = {}
    updaterInternals.homedir = () => home
    expect(providerStoreInternals.homePatchPath()).toBe(join(home, '.dsh', 'cordis.patch.yml'))
  })

  it('reads, writes, and removes files through the real seams', () => {
    const path = tempFile()
    expect(providerStoreInternals.readTextFile(path)).toBeUndefined()
    providerStoreInternals.writeTextFile(path, 'hello')
    expect(providerStoreInternals.readTextFile(path)).toBe('hello')
    providerStoreInternals.removeFile(path)
    expect(providerStoreInternals.readTextFile(path)).toBeUndefined()
    providerStoreInternals.removeFile(path)
  })
})

describe('provider ops', () => {
  it('applies set and unset edits to the effective providers dict', () => {
    expect(providerOpsTarget(null, [])).toEqual({})
    expect(providerOpsTarget({ providers: null }, [])).toEqual({})
    expect(providerOpsTarget({ providers: [] }, [])).toEqual({})
    expect(providerOpsTarget({ providers: 'invalid' }, [])).toEqual({})
    expect(providerOpsTarget({ providers: { scalar: 'x' } }, [
      { op: 'unset', path: ['providers', 'scalar', 'missing'] },
    ])).toEqual({ scalar: 'x' })
    expect(providerOpsTarget({ providers: { arr: [] } }, [
      { op: 'set', path: ['providers', 'arr', 'x'], value: 1 },
    ])).toEqual({ arr: { x: 1 } })
    expect(providerOpsTarget({ providers: { arr: [] } }, [
      { op: 'unset', path: ['providers', 'arr', 'x'] },
    ])).toEqual({ arr: [] })
    const value = { providers: { a: { displayName: 'A' }, scalar: 'x' } }
    expect(providerOpsTarget(value, [
      { op: 'set', path: ['providers', 'b'], value: { baseURL: 'https://b.example' } },
      { op: 'set', path: ['providers', 'a', 'reasoning'], value: 'high' },
      { op: 'set', path: ['providers', 'a', 'nested', 'deep'], value: 1 },
      { op: 'set', path: ['providers', 'scalar', 'replaced'], value: true },
      { op: 'unset', path: ['providers', 'a', 'displayName'] },
      { op: 'unset', path: ['providers', 'scalar', 'missing'] },
      { op: 'unset', path: ['providers', 'b'] },
      { op: 'set', path: ['other', 'x'], value: 1 },
      { op: 'unset', path: ['providers'] },
    ])).toEqual({ a: { reasoning: 'high', nested: { deep: 1 } }, scalar: { replaced: true } })
  })
})

describe('home patch rows', () => {
  it('creates, updates, and restores the llm-pi-ai row', () => {
    const path = tempFile()
    expect(readHomeProviders(path)).toEqual({})
    const first = writeHomeProviders(path, { a: { baseURL: 'https://a.example' } })
    expect(first).toBeUndefined()
    expect(providerStoreInternals.readTextFile(path)).toContain('id: llm-pi-ai')
    expect(readHomeProviders(path)).toEqual({ a: { baseURL: 'https://a.example' } })

    const second = writeHomeProviders(path, { b: {} })
    expect(second).toContain('a:')
    expect(readHomeProviders(path)).toEqual({ b: {} })

    restoreHome(path, second)
    expect(readHomeProviders(path)).toEqual({ a: { baseURL: 'https://a.example' } })
    restoreHome(path, undefined)
    expect(providerStoreInternals.readTextFile(path)).toBeUndefined()
  })

  it('preserves other rows and comments while replacing a non-map config', () => {
    const path = tempFile()
    providerStoreInternals.writeTextFile(path, '# keep\n- id: other\n  disabled: true\n- id: llm-pi-ai\n  config: scalar\n')
    writeHomeProviders(path, { a: {} })
    const text = providerStoreInternals.readTextFile(path)!
    expect(text).toContain('# keep')
    expect(text).toContain('id: other')
    expect(text).toContain('id: llm-pi-ai')
    expect(readHomeProviders(path)).toEqual({ a: {} })
  })

  it('refuses malformed or non-sequence home patches', () => {
    const path = tempFile()
    providerStoreInternals.writeTextFile(path, 'not: [a sequence')
    expect(() => readHomeProviders(path)).toThrow(/home patch must be a YAML sequence/)
    expect(() => writeHomeProviders(path, {})).toThrow(/home patch must be a YAML sequence/)
    providerStoreInternals.writeTextFile(path, 'id: llm-pi-ai\n')
    expect(() => readHomeProviders(path)).toThrow(/home patch must be a YAML sequence/)
    expect(() => writeHomeProviders(path, {})).toThrow(/home patch must be a YAML sequence/)
  })
})

describe('native persistence', () => {
  it('stores the home row and mirrors one whole-dict path op', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    const mutate = vi.fn(async () => {})
    await persistProviders(fakeSettings({ providers: { a: { displayName: 'A' } } }, mutate), [
      { op: 'set', path: ['providers', 'b'], value: {} },
    ], 3)
    expect(readHomeProviders(path)).toEqual({ a: { displayName: 'A' }, b: {} })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers'], value: { a: { displayName: 'A' }, b: {} } },
    ], 3)
  })

  it('skips an empty edit and refuses a missing entry', async () => {
    await persistProviders(fakeSettings({ providers: {} }), [])
    await expect(persistProviders({ describe: () => [] } as unknown as SettingsForms, [
      { op: 'set', path: ['providers', 'a'], value: {} },
    ])).rejects.toThrow(/no configurable plugin entry "llm-pi-ai"/)
  })

  it('restores a prior home file when the native write refuses', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    providerStoreInternals.writeTextFile(path, '- id: other\n')
    await expect(persistProviders(fakeSettings({ providers: { a: {} } }, async () => { throw new Error('boom') }), [
      { op: 'set', path: ['providers', 'b'], value: {} },
    ])).rejects.toThrow('boom')
    expect(providerStoreInternals.readTextFile(path)).toBe('- id: other\n')
  })

  it('removes a first home file when the native write refuses', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    await expect(persistProviders(fakeSettings({ providers: {} }, async () => { throw new Error('nope') }), [
      { op: 'set', path: ['providers', 'a'], value: {} },
    ])).rejects.toThrow('nope')
    expect(providerStoreInternals.readTextFile(path)).toBeUndefined()
  })
})

describe('migration', () => {
  it('seeds and merges the home patch with the home row winning', () => {
    const path = tempFile()
    expect(migrateProvidersToHome({ describe: () => [] } as unknown as SettingsForms, path)).toBe(false)
    expect(migrateProvidersToHome(fakeSettings({ providers: {} }), path)).toBe(false)
    expect(migrateProvidersToHome(fakeSettings({ providers: { a: {}, b: {} } }), path)).toBe(true)
    expect(readHomeProviders(path)).toEqual({ a: {}, b: {} })
    expect(migrateProvidersToHome(fakeSettings({ providers: { a: {} } }), path)).toBe(false)
    expect(migrateProvidersToHome(fakeSettings({ providers: { a: { x: 1 }, c: {} } }), path)).toBe(true)
    expect(readHomeProviders(path)).toEqual({ a: {}, b: {}, c: {} })
  })

  it('runs after the loader settles and tolerates a missing loader or settings', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    const withLoader = new Context()
    withLoader.provide('loader', { await: async () => {} } as never)
    withLoader.provide('settings', fakeSettings({ providers: { a: {} } }) as never)
    scheduleProviderMigration(withLoader)
    await flush()
    expect(readHomeProviders(path)).toEqual({ a: {} })
    await withLoader.fiber.dispose()

    const withoutLoader = new Context()
    withoutLoader.provide('settings', fakeSettings({ providers: { b: {} } }) as never)
    scheduleProviderMigration(withoutLoader)
    await flush()
    expect(readHomeProviders(path)).toEqual({ a: {}, b: {} })
    await withoutLoader.fiber.dispose()

    const bare = new Context()
    bare.provide('loader', { await: async () => {} } as never)
    scheduleProviderMigration(bare)
    await flush()
    await bare.fiber.dispose()
  })

  it('skips migration once the fiber unloads before the loader settles', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    const ctx = new Context()
    let settle: (() => void) | undefined
    ctx.provide('loader', { await: () => new Promise<void>(resolve => { settle = resolve }) } as never)
    ctx.provide('settings', fakeSettings({ providers: { a: {} } }) as never)
    scheduleProviderMigration(ctx)
    await ctx.fiber.dispose()
    settle?.()
    await flush()
    expect(readHomeProviders(path)).toEqual({})
  })

  it('logs a failed migration without escaping the fiber', async () => {
    const path = tempFile()
    providerStoreInternals.homePatchPath = () => path
    providerStoreInternals.writeTextFile(path, 'not: [a sequence')
    const ctx = new Context()
    ctx.provide('loader', { await: async () => {} } as never)
    ctx.provide('settings', fakeSettings({ providers: { a: {} } }) as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    scheduleProviderMigration(ctx)
    await flush()
    expect(warn).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
