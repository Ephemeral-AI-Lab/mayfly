/**
 * Decision tests for the model catalog details: provider filtering, advisory
 * provider failures, and the shape the TUI's picker consumes.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { modelCatalogDetails } from '../../src/remote/catalog-details.ts'

/** One provider with its models, infos, and optional failure. */
interface ProviderSpec {
  readonly id: string
  readonly name?: string
  readonly models?: readonly { id: string, name?: string }[]
  readonly info?: (modelId: string) => unknown
  readonly fail?: boolean
}

/** A context with a fixed provider roster. */
function ctx(providers: readonly ProviderSpec[]): Context {
  return {
    llm: {
      listProviders: (): readonly { id: string, name: string }[] => providers.map(provider => ({ id: provider.id, name: provider.name ?? '' })),
      listModels: async (id: string): Promise<readonly { id: string, name: string }[]> => {
        const provider = providers.find(candidate => candidate.id === id)
        if (provider?.fail === true) throw new Error('unreachable')
        return (provider?.models ?? []).map(model => ({ id: model.id, name: model.name ?? '' }))
      },
      resolveModelInfo: async (id: string, modelId: string): Promise<unknown> =>
        providers.find(candidate => candidate.id === id)?.info?.(modelId),
    },
  } as unknown as Context
}

describe('modelCatalogDetails', () => {
  it('flattens providers into rows with label fallback to the id', async () => {
    const details = await modelCatalogDetails(ctx([
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
      { id: 'bare', models: [{ id: 'solo' }] },
    ]), undefined, new AbortController().signal)
    expect(details.items).toEqual([
      { provider: 'deepseek', id: 'chat', name: 'Chat', providerLabel: 'DeepSeek' },
      { provider: 'bare', id: 'solo', name: 'solo', providerLabel: 'bare' },
    ])
    expect(Object.isFrozen(details)).toBe(true)
  })

  it('keeps only the requested provider and refuses an unregistered one', async () => {
    const details = await modelCatalogDetails(ctx([
      { id: 'a', models: [{ id: 'm1' }] },
      { id: 'b', models: [{ id: 'm2' }] },
    ]), 'a', new AbortController().signal)
    expect(details.items.map(item => item.provider)).toEqual(['a'])
    await expect(modelCatalogDetails(ctx([{ id: 'a' }]), 'ghost', new AbortController().signal))
      .rejects.toThrow('provider "ghost" is not registered')
  })

  it('carries context window and efforts only when the adapter answers them', async () => {
    const details = await modelCatalogDetails(ctx([
      {
        id: 'p',
        models: [{ id: 'thin' }, { id: 'rich' }],
        info: (modelId: string): unknown => modelId === 'rich'
          ? { context: { contextWindow: 131072 }, reasoning: { efforts: [{ id: 'high' }, { id: 'low' }], defaultEffort: 'high' } }
          : { context: { contextWindow: 8192 } },
      },
    ]), undefined, new AbortController().signal)
    const rich = details.items.find(item => item.id === 'rich')
    expect(rich).toMatchObject({ contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' })
    const thin = details.items.find(item => item.id === 'thin')
    expect(thin).toMatchObject({ contextWindow: 8192 })
    expect(thin).not.toHaveProperty('efforts')
    expect(thin).not.toHaveProperty('defaultEffort')
  })

  it('an unavailable advisory provider contributes no rows without failing the read', async () => {
    const details = await modelCatalogDetails(ctx([
      { id: 'down', fail: true, models: [{ id: 'ghost' }] },
      { id: 'up', models: [{ id: 'real' }] },
    ]), undefined, new AbortController().signal)
    expect(details.items.map(item => item.provider)).toEqual(['up'])
  })

  it('omits metadata whose info resolution rejects', async () => {
    const throwing: ProviderSpec = {
      id: 'p',
      models: [{ id: 'm' }],
      info: (): never => { throw new Error('info unavailable') },
    }
    const details = await modelCatalogDetails(ctx([throwing]), undefined, new AbortController().signal)
    expect(details.items[0]).toMatchObject({ provider: 'p', id: 'm' })
    expect(details.items[0]).not.toHaveProperty('contextWindow')
  })

  it('refuses to start on an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(modelCatalogDetails(ctx([{ id: 'p' }]), undefined, controller.signal)).rejects.toThrow()
  })
})
