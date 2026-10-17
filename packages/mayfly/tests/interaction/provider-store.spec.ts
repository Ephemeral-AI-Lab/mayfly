/** Native provider-route addressing over the configurable-provider directory.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-store
 */
import { Context } from '@deepseek-ai/cordis'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  persistProviders,
  providerAddress,
  providerContainer,
  providerDescriptor,
  providerDirectory,
  providerProfileAt,
  providerValueAt,
} from '../../src/interaction/provider-store.ts'

/** A context whose native LLM registry declares the supplied directory entries. */
function directoryContext(entries: readonly unknown[]): Context {
  const ctx = new Context()
  ctx.provide('llm', { listConfigurableProviders: () => entries } as never)
  return ctx
}

const entry = (over: Record<string, unknown>): Record<string, unknown> => ({
  provider: 'route',
  displayName: 'Route',
  settingsNs: 'llm-routes',
  settingsPath: ['providers', 'route'],
  ...over,
})

const descriptor = (ns: string, value: unknown, revision = 0) => ({
  ns, autoGenerate: true, schema: {}, value, revision, applies: 'live' as const,
})

function fakeSettings(entries: readonly unknown[], mutate: (ns: string, ops: unknown, expected?: number) => Promise<void> = async () => {}): SettingsForms {
  return { describe: () => entries, mutate } as unknown as SettingsForms
}

describe('provider addressing', () => {
  it('reads the native configurable-provider directory, or nothing without it', () => {
    const ctx = directoryContext([entry({})])
    expect(providerDirectory(ctx).map(item => item.provider)).toEqual(['route'])
    expect(providerDirectory(new Context())).toEqual([])
  })

  it('returns the adapter-declared namespace, path, container, and declaration fact', () => {
    const ctx = directoryContext([
      entry({ provider: 'anthropic', displayName: 'Anthropic', declared: false, settingsPath: ['providers', 'anthropic'] }),
      entry({ provider: 'gateway', declared: true, settingsPath: ['providers', 'gateway'] }),
      entry({ provider: 'whole', settingsNs: 'llm-whole', settingsPath: [] }),
    ])
    expect(providerAddress(ctx, 'anthropic')).toMatchObject({
      ns: 'llm-routes', path: ['providers', 'anthropic'], container: ['providers'], declared: false, displayName: 'Anthropic',
    })
    expect(providerAddress(ctx, 'gateway')).toMatchObject({ declared: true, path: ['providers', 'gateway'] })
    expect(providerAddress(ctx, 'whole')).toMatchObject({ ns: 'llm-whole', path: [], container: undefined })
    expect(providerAddress(ctx, 'missing')).toBeUndefined()
    expect(providerAddress(directoryContext([entry({ settingsPath: undefined })]), 'route')).toMatchObject({ path: [], container: undefined })
  })

  it('chooses the largest native route-dict group and ignores whole-section profiles', () => {
    const ctx = directoryContext([
      entry({ provider: 'a', settingsPath: ['providers', 'a'] }),
      entry({ provider: 'b', settingsPath: ['providers', 'b'] }),
      entry({ provider: 'single', settingsPath: ['only'] }),
      entry({ provider: 'whole', settingsPath: [] }),
      entry({ provider: 'other', settingsNs: 'other-ns', settingsPath: ['routes', 'other'] }),
    ])
    expect(providerContainer(ctx)).toEqual({ ns: 'llm-routes', container: ['providers'] })
    expect(providerContainer(new Context())).toBeUndefined()
    expect(providerContainer(directoryContext([entry({ settingsPath: [] })]))).toBeUndefined()
  })

  it('breaks equal-size groups deterministically by namespace then container', () => {
    const ctx = directoryContext([
      entry({ provider: 'z', settingsNs: 'z-ns', settingsPath: ['routes', 'z'] }),
      entry({ provider: 'a', settingsNs: 'a-ns', settingsPath: ['providers', 'a'] }),
    ])
    expect(providerContainer(ctx)).toEqual({ ns: 'a-ns', container: ['providers'] })
  })
})

describe('provider values', () => {
  it('reads namespace-rooted paths without mutating the section', () => {
    const value = { providers: { custom: { displayName: 'Custom', models: [{ id: 'one' }] } }, untouched: true }
    expect(providerValueAt(value, [])).toBe(value)
    expect(providerValueAt(value, ['providers', 'custom', 'displayName'])).toBe('Custom')
    expect(providerValueAt(value, ['providers', 'missing'])).toBeUndefined()
    expect(providerValueAt(value, ['providers', 'custom', 'models', '0'])).toBeUndefined()
    expect(providerValueAt(null, ['providers'])).toBeUndefined()
    expect(providerValueAt({ providers: null }, ['providers', 'x'])).toBeUndefined()
    expect(providerProfileAt(value, ['providers', 'custom'])).toEqual({ displayName: 'Custom', models: [{ id: 'one' }] })
    expect(providerProfileAt(value, ['providers', 'custom', 'models'])).toBeUndefined()
    expect(providerProfileAt({ providers: { scalar: 'x' } }, ['providers', 'scalar'])).toBeUndefined()
    expect(providerProfileAt(null, ['providers'])).toBeUndefined()
  })

  it('finds the live descriptor by namespace only', () => {
    const settings = fakeSettings([descriptor('llm-routes', {}), descriptor('other', {})])
    expect(providerDescriptor(settings, 'llm-routes')?.ns).toBe('llm-routes')
    expect(providerDescriptor(settings, 'missing')).toBeUndefined()
  })
})

describe('native persistence', () => {
  it('writes namespace-rooted path ops through settings.mutate at the read revision', async () => {
    const mutate = vi.fn(async () => {})
    const settings = fakeSettings([descriptor('llm-routes', { providers: {} })], mutate)
    await persistProviders(settings, 'llm-routes', [
      { op: 'set', path: ['providers', 'custom'], value: { apiKeyEnv: 'CUSTOM_KEY' } },
      { op: 'set', path: ['providers', 'custom', 'displayName'], value: 'Custom' },
      { op: 'unset', path: ['providers', 'gone'] },
    ], 3)
    expect(mutate).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledWith('llm-routes', [
      { op: 'set', path: ['providers', 'custom'], value: { apiKeyEnv: 'CUSTOM_KEY' } },
      { op: 'set', path: ['providers', 'custom', 'displayName'], value: 'Custom' },
      { op: 'unset', path: ['providers', 'gone'] },
    ], 3)
  })

  it('skips an empty edit and refuses a namespace the native service never describes', async () => {
    const mutate = vi.fn(async () => {})
    const settings = fakeSettings([descriptor('llm-routes', {})], mutate)
    await persistProviders(settings, 'llm-routes', [])
    expect(mutate).not.toHaveBeenCalled()
    await expect(persistProviders(settings, 'missing', [
      { op: 'set', path: ['providers', 'custom'], value: {} },
    ])).rejects.toThrow(/no configurable plugin entry "missing"/)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('lets a native refusal escape unchanged', async () => {
    const settings = fakeSettings([descriptor('llm-routes', {})], async () => { throw new Error('boom') })
    await expect(persistProviders(settings, 'llm-routes', [
      { op: 'set', path: ['providers', 'custom'], value: {} },
    ])).rejects.toThrow('boom')
  })
})
