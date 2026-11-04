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

  it('omits an empty effort catalog instead of exposing an empty selector', async () => {
    const details = await modelCatalogDetails(ctx([{ id: 'p', models: [{ id: 'm' }], info: () => ({ reasoning: { efforts: [] } }) }]), undefined, new AbortController().signal)
    expect(details.items[0]).not.toHaveProperty('efforts')
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

  it('preserves optional discovery paths and usage metadata without loading a skill body', async () => {
    const { ctx } = fixture()
    ctx.skills.snapshot = (async () => ({ complete: false, skills: [{
      path: '/host/skills/review/SKILL.md', name: 'review', description: 'Review', whenToUse: 'Before merge',
      invocation: { userInvocable: true, modelInvocable: true }, source: 'workspace', provider: 'local',
    }] })) as typeof ctx.skills.snapshot
    await expect(skillCatalog(ctx, SessionId('one'), new AbortController().signal)).resolves.toEqual({ complete: false, skills: [{
      path: '/host/skills/review/SKILL.md', name: 'review', description: 'Review', whenToUse: 'Before merge', source: 'workspace', provider: 'local', modelInvocable: true,
    }] })
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

  function permissions(events: readonly unknown[] = []) {
    const options = [{ value: 'safe', name: 'Safe' }, { value: 'open', name: 'Open' }]
    const dispose = vi.fn()
    const source = { observeSession: vi.fn(async () => ({ events, [Symbol.dispose]: dispose })) }
    const values = { permissionPresets: {
      catalog: () => ({ options, defaultOptions: options, defaultPreset: 'safe' }),
      resolve: (value: string) => {
        return value === 'open' ? { sandbox: 'danger-full-access', approval: 'never' } : { sandbox: 'workspace-write', approval: 'ask' }
      },
      defaultPreset: 'safe',
    }, shell: { sandboxMode: 'workspace-write' as string | undefined }, approval: { config: { policy: 'ask' as string | undefined } }, sessionQuery: source }
    const context = { ...values, get: (key: keyof typeof values) => values[key] } as unknown as Context
    return { context, values, source, dispose }
  }

  it('resolves permission bundles and the native default for a genuinely sessionless view', async () => {
    const { context, values, source } = permissions()
    const signal = new AbortController().signal
    const baseline = await permissionCatalogDetails(context, {}, signal)
    expect(baseline).toMatchObject({ yolo: false, defaultPreset: 'safe', specs: { safe: { sandbox: 'workspace-write', approval: 'ask' }, open: { sandbox: 'danger-full-access', approval: 'never' } } })
    expect(Object.isFrozen(baseline.specs)).toBe(true)
    values.permissionPresets.defaultPreset = 'open'
    values.permissionPresets.catalog = () => ({ options: [], defaultOptions: [], defaultPreset: 'open' })
    expect((await permissionCatalogDetails(context, {}, signal)).yolo).toBe(true)
    expect(source.observeSession).not.toHaveBeenCalled()
  })

  it('reads current knobs passively even for a custom or withdrawn preset and uses the newest override', async () => {
    const f = permissions([
      { type: 'permission/preset', data: { preset: 'withdrawn' } },
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
      { type: 'approval/policy', data: { policy: 'never' } },
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    ])
    const signal = new AbortController().signal
    expect((await permissionCatalogDetails(f.context, { sessionId: SessionId('cold-child') }, signal)).yolo).toBe(true)
    expect(f.source.observeSession).toHaveBeenCalledExactlyOnceWith('cold-child', { signal, projectionMode: 'none' })
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    { sandbox: 'danger-full-access', approval: 'never', yolo: true },
    { sandbox: 'danger-full-access', approval: undefined, yolo: false },
    { sandbox: 'danger-full-access', approval: 'ask', yolo: false },
    { sandbox: 'workspace-write', approval: 'never', yolo: false },
    { sandbox: undefined, approval: 'never', yolo: false },
  ])('uses composition defaults for missing Session knobs: $sandbox / $approval', async ({ sandbox, approval, yolo }) => {
    const f = permissions()
    f.values.shell.sandboxMode = sandbox
    f.values.approval.config.policy = approval
    expect((await permissionCatalogDetails(f.context, { sessionId: SessionId('empty') }, new AbortController().signal)).yolo).toBe(yolo)
  })

  it('retires cancelled and replaced native reads and releases their late observations', async () => {
    const f = permissions()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.source.observeSession>>>()
    f.source.observeSession.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const read = permissionCatalogDetails(f.context, { sessionId: SessionId('one') }, controller.signal)
    controller.abort(new Error('cancelled permission read'))
    pending.resolve({ events: [], [Symbol.dispose]: f.dispose })
    await expect(read).rejects.toThrow('cancelled permission read')
    expect(f.dispose).toHaveBeenCalledOnce()
    const next = Promise.withResolvers<Awaited<ReturnType<typeof f.source.observeSession>>>()
    f.source.observeSession.mockReturnValue(next.promise)
    const stale = permissionCatalogDetails(f.context, { sessionId: SessionId('one') }, new AbortController().signal)
    f.values.sessionQuery = { observeSession: vi.fn() }
    next.resolve({ events: [], [Symbol.dispose]: f.dispose })
    await expect(stale).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.dispose).toHaveBeenCalledTimes(2)
    f.source.observeSession.mockResolvedValue({ events: [], [Symbol.dispose]: f.dispose })
    f.context.get = (() => undefined) as typeof f.context.get
    await expect(permissionCatalogDetails(f.context, { sessionId: SessionId('one') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.dispose).toHaveBeenCalledTimes(3)
  })
})
