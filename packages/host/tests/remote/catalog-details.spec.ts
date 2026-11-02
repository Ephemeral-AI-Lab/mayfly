/**
 * Decision tests for the model catalog details: provider filtering, advisory
 * provider failures, and the shape the TUI's picker consumes.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defaultModel, modelCatalogDetails, permissionCatalogDetails, skillCatalog } from '../../src/remote/catalog-details.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

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

  it('stops provider discovery after cancellation instead of starting later requests', async () => {
    const controller = new AbortController()
    const listModels = vi.fn(async () => { controller.abort(new Error('cancelled discovery')); return [] })
    const resolveModelInfo = vi.fn()
    const context = { llm: { listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], listModels, resolveModelInfo } } as unknown as Context
    await expect(modelCatalogDetails(context, undefined, controller.signal)).rejects.toThrow('cancelled discovery')
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })
})

describe('skillCatalog lifetime', () => {
  function fixture(): { ctx: Context, changeAgent(): void, changeDirectory(): void, finish(): void } {
    const session = { id: SessionId('one'), header: { cwd: '/host/work' } }
    const agent = { id: session.id, session }
    let registered: unknown = agent
    let cwd = '/host/work'
    let finish = (): void => {}
    const snapshot = new Promise(resolve => { finish = () => resolve({ complete: true, skills: [
      { name: 'skill', description: 'useful', invocation: { userInvocable: true, modelInvocable: false }, source: 'workspace', provider: 'local' },
      { name: 'hidden', invocation: { userInvocable: false } },
    ] }) })
    const ctx = {
      agents: { get: () => registered }, sessions: { get: () => session },
      sessionProjections: { snapshot: () => ({ values: { workingDirectory: cwd } }) },
      skills: { snapshot: () => snapshot },
    } as unknown as Context
    return { ctx, changeAgent: () => { registered = { ...agent } }, changeDirectory: () => { cwd = '/host/moved' }, finish: () => finish() }
  }

  it('returns only invocable native metadata for the exact unchanged Agent', async () => {
    const { ctx, finish } = fixture()
    const pending = skillCatalog(ctx, SessionId('one'), new AbortController().signal)
    finish()
    await expect(pending).resolves.toEqual({ complete: true, skills: [{ name: 'skill', description: 'useful', source: 'workspace', provider: 'local', modelInvocable: false }] })
  })

  it('rejects a late snapshot after exact-Agent replacement', async () => {
    const { ctx, finish, changeAgent } = fixture()
    const pending = skillCatalog(ctx, SessionId('one'), new AbortController().signal)
    await Promise.resolve()
    changeAgent()
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })

  it('rejects a late snapshot after the effective Host directory changes', async () => {
    const { ctx, finish, changeDirectory } = fixture()
    const pending = skillCatalog(ctx, SessionId('one'), new AbortController().signal)
    await Promise.resolve()
    changeDirectory()
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })

  it('rejects a snapshot returned after cancellation', async () => {
    const { ctx, finish } = fixture()
    const controller = new AbortController()
    const pending = skillCatalog(ctx, SessionId('one'), controller.signal)
    await Promise.resolve()
    controller.abort(new Error('cancelled skills'))
    finish()
    await expect(pending).rejects.toThrow('cancelled skills')
  })
})

describe('native selection catalogs', () => {
  it('reads and saves default models through the native owner without a Session', async () => {
    let selection = { provider: 'a', model: 'one' } as { provider: string, model: string, reasoningEffort?: string }
    const saveSelection = vi.fn(async (next: typeof selection) => { selection = next })
    const context = { agentDefaultModel: { currentSelection: () => selection, saveSelection } } as unknown as Context
    await expect(defaultModel(context, { operation: 'read' }, new AbortController().signal)).resolves.toEqual(selection)
    expect(saveSelection).not.toHaveBeenCalled()
    await expect(defaultModel(context, { operation: 'select', provider: 'b', model: 'two', reasoningEffort: 'high' }, new AbortController().signal))
      .resolves.toEqual({ provider: 'b', model: 'two', reasoningEffort: 'high' })
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'b', model: 'two', reasoningEffort: 'high' })
    await expect(defaultModel(context, { operation: 'select', provider: 'a', model: 'three' }, new AbortController().signal))
      .resolves.toEqual({ provider: 'a', model: 'three' })
  })

  it('does not publish a saved default after cancellation', async () => {
    const controller = new AbortController()
    const currentSelection = vi.fn()
    const context = { agentDefaultModel: { currentSelection, saveSelection: async () => { controller.abort(new Error('cancelled model')) } } } as unknown as Context
    await expect(defaultModel(context, { operation: 'select', provider: 'a', model: 'b' }, controller.signal)).rejects.toThrow('cancelled model')
    expect(currentSelection).not.toHaveBeenCalled()
  })

  it('resolves permission bundles and accepts yolo only for the complete native bundle', () => {
    const options = [{ value: 'safe', name: 'Safe' }, { value: 'open', name: 'Open' }]
    const context = { permissionPresets: {
      catalog: () => ({ options, defaultOptions: options, defaultPreset: 'safe' }),
      resolve: (value: string) => {
        if (value === 'unknown') throw new Error('withdrawn')
        return value === 'open' ? { sandbox: 'danger-full-access', approval: 'never' } : { sandbox: 'workspace-write', approval: 'ask' }
      },
    } } as unknown as Context
    const signal = new AbortController().signal
    const baseline = permissionCatalogDetails(context, {}, signal)
    expect(baseline).toMatchObject({ yolo: false, defaultPreset: 'safe', specs: { safe: { sandbox: 'workspace-write', approval: 'ask' }, open: { sandbox: 'danger-full-access', approval: 'never' } } })
    expect(permissionCatalogDetails(context, { currentPreset: 'open' }, signal).yolo).toBe(true)
    expect(permissionCatalogDetails(context, { currentPreset: 'safe' }, signal).yolo).toBe(false)
    expect(permissionCatalogDetails(context, { currentPreset: 'unknown' }, signal).yolo).toBe(false)
    expect(Object.isFrozen(baseline.specs)).toBe(true)
  })
})
