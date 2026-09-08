/**
 * The model-family commands over the real command runtime and the plugin
 * wiring: `/model` picker and direct switch, `/effort` selector and direct
 * level, the commit path's session-only/persist split, the alias relation,
 * and the unload guard.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import * as commandsPlugin from '../../src/interaction/commands-plugin.ts'
import { createModelListCache, cycleSessionModel, openModelPicker, registerModelCommands, type ModelListCache } from '../../src/interaction/model-commands.ts'
import { PromptEditorController, setSharedEditor } from '../../src/interaction/editor-instance.ts'
import { fakeMayflyContext, KEY, type FakeScreen } from './fakes.ts'
import { setModelsDevLoader } from '../../src/interaction/models-dev.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { renderRequest } from './request-fixture.ts'

// Tests never touch the network catalog.
setModelsDevLoader(() => Promise.resolve(undefined))

/** The notices the shared editor received. */
let notices: string[] = []
let modelListCache: ModelListCache = createModelListCache()

afterEach(() => {
  vi.useRealTimers()
  modelListCache = createModelListCache()
  notices = []
})

interface TestModelRef { current: ModelSelection }

/** Mutable projection source used by the native dsh service doubles. */
function fakeModelRef(selection: ModelSelection): { ref: TestModelRef, writes: ModelSelection[] } {
  const writes: ModelSelection[] = []
  const state = { current: selection }
  const ref = {
    get current() { return state.current },
    set current(next: ModelSelection) {
      state.current = next
      writes.push(next)
    },
    assembled: undefined,
  }
  return { ref, writes }
}

/** Provide the renderer-neutral app boundary to standalone command contexts. */
function provideModelBoundary(
  ctx: Context,
  agent: Agent | undefined,
  modelRef?: TestModelRef,
): void {
  ctx.provide('mayflyCurrentAgent', {
    current: () => agent ?? null,
    revision: () => 0,
    subscribe: (listener: (current: Agent | null, revision: number) => void) => {
      listener(agent ?? null, 0)
      return () => {}
    },
  } as never)
  ctx.provide('sessionProjections', {
    snapshot: () => ({
      asOfSeq: 0,
      values: modelRef === undefined
        ? {}
        : { modelSelection: { lastUsed: modelRef.current, next: modelRef.current } },
    }),
    onChanged: () => () => {},
  } as never)
  ctx.provide('sessionController', {
    selectModel: async (request: ModelSelection & { sessionId: string }) => {
      if (modelRef === undefined) throw new Error('model selection is unavailable for this session')
      const selected = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      }
      modelRef.current = selected
      return { selected }
    },
  } as never)
  ctx.provide('tools', { schemas: () => [] } as never)
  if (ctx.get('mayflySkillsCatalog') === undefined) {
    ctx.provide('mayflySkillsCatalog', {
      userInvocable: () => [],
      refresh: () => Promise.resolve(),
      setForTest: () => {},
    } as never)
  }
}

/** The fake llm catalog: providers → models, with per-model metadata. */
interface FakeCatalog {
  providers?: { id: string, name: string }[]
  configurable?: { provider: string, displayName: string }[]
  discovered?: { id: string, contextWindow?: number }[]
  models?: Record<string, { id: string, name: string }[]>
  /** Return a rejected metadata promise for these model ids. */
  failInfoFor?: string[]
  /** Throw the catalog listing for these provider ids. */
  failListFor?: string[]
  reasoning?: { efforts: { id: string, name: string }[], defaultEffort: string } | null
}

function fakeLlm(catalog: FakeCatalog = {}): LlmRuntime {
  const models = catalog.models ?? {
    mock: [
      { id: 'mock', name: 'Mock' },
      { id: 'mock-pro', name: 'Mock Pro' },
    ],
  }
  return {
    listProviders: () => catalog.providers ?? [{ id: 'mock', name: 'Mock' }],
    listConfigurableProviders: () => (catalog.configurable ?? [
      { provider: 'anthropic', displayName: 'Anthropic' },
    ]).map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', entry.provider],
      declared: false,
    })),
    discoverModels: async () => [...catalog.discovered ?? []],
    listModels: async (provider: string) => {
      if (catalog.failListFor?.includes(provider)) throw new Error('catalog down')
      return [...models[provider] ?? []]
    },
    resolveModelInfo: async (provider: string, model: string) => {
      if (catalog.failInfoFor?.includes(model)) throw new Error('no metadata')
      return {
        provider,
        id: model,
        name: model,
        ...(catalog.reasoning === null ? {} : {
          context: { contextWindow: 65536 },
          reasoning: catalog.reasoning ?? {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        }),
      }
    },
  } as unknown as LlmRuntime
}

async function mount(options: {
  catalog?: FakeCatalog
  attach?: boolean
  modelRef?: TestModelRef
  defaults?: { selection: ModelSelection, saveError?: Error } | false
  llm?: LlmRuntime
  display?: boolean
  settings?: object
  credentials?: object
} = {}): Promise<{
  ctx: Context
  screen: FakeScreen
  agent: Agent
  modelRef: TestModelRef
  writes: ModelSelection[]
  saveSelection: ReturnType<typeof vi.fn>
  fiber: { dispose(): Promise<void> }
}> {
  const { ctx, screen } = fakeMayflyContext()
  const interaction = new UiInteractionService(ctx)
  mountUiRegistryObservers(ctx)
  await Promise.resolve()
  const drivers = new WeakMap<UiSurfaceModel, { render(width: number): string[], handleInput(data: string): void }>()
  const driver = (model: UiSurfaceModel) => {
    const previous = drivers.get(model)
    if (previous !== undefined) return previous
    let compiled = renderRequest(model)
    const sync = (width = 80) => {
      if (compiled.runtime.interaction?.revision !== model.revision) compiled = renderRequest(model, { columns: width, rows: 24 }, compiled.runtime)
      return compiled
    }
    const value = { render: (width: number) => sync(width).component.render(width), handleInput: (data: string) => sync().input(data) }
    drivers.set(model, value)
    return value
  }
  const syncOverlays = () => {
    screen.overlays.splice(0, screen.overlays.length, ...ctx.mayflyOverlays.list().map(entry => ({ component: driver(interaction.get('overlay', entry.id)!) as never, hidden: entry.hidden } as never)))
  }
  interaction.subscribe(syncOverlays)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  ctx.provide('llm', options.llm ?? fakeLlm(options.catalog))
  const session = ctx.sessions.create(SessionId('model-spec'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  const fake = fakeModelRef({ provider: 'mock', model: 'mock' })
  const modelRef = options.modelRef ?? fake.ref
  const writes = options.modelRef === undefined ? fake.writes : []
  const saveSelection = vi.fn(() => options.defaults?.saveError === undefined
    ? Promise.resolve()
    : Promise.reject(options.defaults.saveError))
  if (options.defaults !== false) {
    ctx.provide('agentDefaultModel', {
      currentSelection: () => options.defaults?.selection ?? { provider: 'mock', model: 'mock' },
      saveSelection,
    } as unknown as AgentDefaultModelConfig)
  }
  if (options.attach !== false) {
    ctx.provide('testSession', { current: agent, modelRef })
  }
  if (options.settings !== undefined) ctx.provide('settings', options.settings as never)
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials as never)
  setSharedEditor(ctx, {
    editor: { focused: false, render: () => [], invalidate: () => {} } as never,
    submitPrompt: () => {},
    report: (_id, feedback) => { notices.push(feedback.message) },
  })
  const fiber = await ctx.plugin(commandsPlugin)
  return { ctx, screen, agent, modelRef, writes, saveSelection, fiber }
}

const signal = (): AbortSignal => new AbortController().signal

/** The overlay component of the last shown registry surface. */
function overlay(screen: FakeScreen): { handleInput(data: string): void, render(width: number): string[] } {
  const entry = screen.overlays[screen.overlays.length - 1]
  expect(entry).toBeDefined()
  return entry!.component as unknown as { handleInput(data: string): void, render(width: number): string[] }
}

async function selectModel(ctx: Context, provider = 'mock', model = 'mock'): Promise<UiSurfaceModel> {
  ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!.emit({
    kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [JSON.stringify([provider, model])],
  })
  await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')).toBeDefined())
  return ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
}

describe('model-family commands', () => {
  it('registers /model and /effort with the thinking alias', async () => {
    const { ctx, agent } = await mount()
    const names = ctx.commands.list(agent).map(command => command.name)
    expect(names).toContain('model')
    expect(names).toContain('effort')
    expect(names).not.toContain('provider')
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('thinking')).toBe('effort')
    expect(ctx.commands.find(agent, 'model')?.input?.hint).toBe('[name]')
  })

  it('unregisters both commands and the alias on unload', async () => {
    const { ctx, agent, fiber } = await mount()
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'model')).toBeUndefined()
    expect(ctx.commands.find(agent, 'effort')).toBeUndefined()
    expect(ctx.commands.find(agent, 'provider')).toBeUndefined()
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('thinking')).toBeUndefined()
  })

  it('/model guards: no session and no selection handle', async () => {
    const { ctx, agent } = await mount({ attach: false })
    expect((await ctx.commands.execute(agent, '/model', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'no session is live yet' })

    const handleless = fakeMayflyContext()
    await handleless.ctx.plugin(SessionStore)
    await handleless.ctx.plugin(CommandRuntime)
    handleless.ctx.provide('llm', fakeLlm())
    const bareSession = handleless.ctx.sessions.create(SessionId('handleless'))
    const bareAgent = { id: bareSession.id, session: bareSession, status: 'idle' } as unknown as Agent
    handleless.ctx.provide('testSession', { current: bareAgent, modelRef: undefined })
    await handleless.ctx.plugin(commandsPlugin)
    expect((await handleless.ctx.commands.execute(bareAgent, '/model', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'no session is live yet' })
  })

  it('/model reports the llm guard before anything else', async () => {
    // A tree whose llm provide never happened: every command answers the
    // service guard before touching the catalog.
    const bare = fakeMayflyContext()
    await bare.ctx.plugin(SessionStore)
    await bare.ctx.plugin(CommandRuntime)
    const session = bare.ctx.sessions.create(SessionId('no-llm'))
    const bareAgent = { id: session.id, session, status: 'idle' } as unknown as Agent
    const fake = fakeModelRef({ provider: 'mock', model: 'mock' })
    bare.ctx.provide('testSession', { current: bareAgent, modelRef: fake.ref })
    bare.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'mock', model: 'mock' }),
      saveSelection: vi.fn(),
    } as unknown as AgentDefaultModelConfig)
    await bare.ctx.plugin(commandsPlugin)
    expect((await bare.ctx.commands.execute(bareAgent, '/model', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'the llm service is unavailable' })
  })

  it('/model opens the picker with provider tabs and inline effort choices', async () => {
    const { ctx, agent } = await mount()
    const execution = await ctx.commands.execute(agent, '/model', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const node = JSON.stringify(ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')?.node)
    expect(node).toContain('"badge":"current"')
    expect(node).toContain('64k context')
    expect(node).toContain('Mock Pro')
    expect(node).not.toContain('Set as default')
  })

  it('/model degrades rows whose metadata lookup fails', async () => {
    const { ctx, screen, agent } = await mount({ catalog: { failInfoFor: ['mock-pro'] } })
    await ctx.commands.execute(agent, '/model', [], signal())
    const rows = overlay(screen).render?.(80) ?? []
    const proRow = rows.find(row => row.includes('Mock Pro'))
    expect(proRow).toBeDefined()
    expect(proRow).not.toContain('ctx')
  })

  it('/model skips providers whose catalog listing fails', async () => {
    const { ctx, agent } = await mount({
      catalog: {
        providers: [{ id: 'mock', name: 'Mock' }, { id: 'broken', name: 'Broken' }],
        failListFor: ['broken'],
      },
    })
    const execution = await ctx.commands.execute(agent, '/model mock-pro', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'Switched to mock-pro (mock)' })
  })

  it('/model answers "no models" for an empty catalog and unknown ids', async () => {
    const empty = await mount({ catalog: { providers: [], models: {} } })
    // Restore one provider for the mount, then exercise the empty catalog
    // through a context whose only provider's listing fails.
    const execution = await empty.ctx.commands.execute(empty.agent, '/model', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(empty.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')?.node)).toContain('No models advertised')

    const unknown = await mount()
    expect((await unknown.ctx.commands.execute(unknown.agent, '/model nope', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'unknown model: nope' })
  })

  it('/model prefers the live provider on an ambiguous id and lists candidates otherwise', async () => {
    const ambiguous = await mount({
      catalog: {
        providers: [{ id: 'mock', name: 'Mock' }, { id: 'other', name: 'Other' }],
        models: {
          mock: [{ id: 'shared', name: 'Shared' }],
          other: [{ id: 'shared', name: 'Shared' }],
        },
      },
    })
    const execution = await ambiguous.ctx.commands.execute(ambiguous.agent, '/model shared', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'Switched to shared (mock)' })
  })

  it('/model picker commits on Enter with the segment draft and persists the default', async () => {
    const { ctx, screen, agent, writes, saveSelection } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    overlay(screen).handleInput(KEY.enter)
    await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')).toBeDefined())
    const options = ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'high')
    options.invoke('default')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes).toEqual([{ provider: 'mock', model: 'mock', reasoningEffort: 'high' as never }])
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'mock', model: 'mock', reasoningEffort: 'high' as never })
    expect(notices).toEqual([])
  })

  it('/model picker commits through the explicit session-only action and skips the default write', async () => {
    const { ctx, agent, writes, saveSelection } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-pro')
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'high')
    options.invoke('session')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes).toEqual([{ provider: 'mock', model: 'mock-pro', reasoningEffort: 'high' as never }])
    expect(saveSelection).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('/model picker contains a commit after the current Agent disappears', async () => {
    const { ctx, agent, writes } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-pro')
    ;(ctx.get('testSession') as { current: Agent | null }).current = null
    options.invoke('default')
    await vi.waitFor(() => { expect(options.disposed).toBe(true) })
    expect(writes).toEqual([])
  })

  it('/model picker contains a commit after its selection projection disappears', async () => {
    const { ctx, agent, writes } = await mount({ defaults: false })
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-pro')
    ;(ctx.get('testSession') as { current: Agent, modelRef?: TestModelRef }).modelRef = undefined
    options.invoke('default')
    await vi.waitFor(() => expect(options.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', message: 'no session is live yet' })])))
    expect(writes).toEqual([])
  })

  it('/model adjusts the effort on the focused row instead of the saved model', async () => {
    const { ctx, agent, writes } = await mount({
      catalog: { models: { mock: [
        { id: 'mock', name: 'Mock' },
        { id: 'mock-pro', name: 'Mock Pro' },
        { id: 'mock-vision', name: 'Mock Vision' },
      ] } },
    })
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-vision')
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'low')
    options.invoke('default')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes).toEqual([{ provider: 'mock', model: 'mock-vision', reasoningEffort: 'low' as never }])
  })

  it('rejects malformed picker actions without mutating the selection', async () => {
    const { ctx, agent, writes } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    const root = ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    root.invoke('fixture.invalid')
    root.emit({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: ['invalid'] })
    expect(writes).toEqual([])
  })

  it('/model direct switch skips the save when the default already matches', async () => {
    const { ctx, agent, saveSelection } = await mount({
      defaults: { selection: { provider: 'mock', model: 'mock-pro' } },
    })
    const execution = await ctx.commands.execute(agent, '/model mock-pro', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'Switched to mock-pro (mock)' })
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('/model surfaces a failed default save and works without the default service', async () => {
    const failing = await mount({
      defaults: { selection: { provider: 'mock', model: 'mock' }, saveError: new Error('disk full') },
    })
    const execution = await failing.ctx.commands.execute(failing.agent, '/model mock-pro', [], signal())
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'Switched to mock-pro (mock) — failed to save default: disk full',
    })
  })

  it('/model surfaces a rejected structured selection action', async () => {
    const mounted = await mount()
    ;(mounted.ctx.get('sessionController') as unknown as {
      selectModel: () => Promise<never>
    }).selectModel = async () => { throw new Error('selection rejected') }
    await expect(mounted.ctx.commands.execute(mounted.agent, '/model mock-pro', [], signal()))
      .rejects.toThrow('selection rejected')
  })

  it('/effort guards: no reasoning metadata and resolve failure', async () => {
    const plain = await mount({ catalog: { reasoning: null } })
    expect((await plain.ctx.commands.execute(plain.agent, '/effort', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'the current model exposes no reasoning efforts' })
    expect((await plain.ctx.commands.execute(plain.agent, '/effort low', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'the current model exposes no reasoning efforts' })

    const broken = await mount({ catalog: { failInfoFor: ['mock'] } })
    expect((await broken.ctx.commands.execute(broken.agent, '/effort', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'could not resolve the current model: no metadata' })
  })

  it('/effort opens the segment selector seeded at the live effort', async () => {
    const { ctx, agent, writes } = await mount()
    await ctx.commands.execute(agent, '/effort', [], signal())
    const options = ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    const node = JSON.stringify(options.node)
    expect(node).toContain('Provider default')
    expect(node).toContain('low')
    expect(node).toContain('high')
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'high')
    options.invoke('default')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    // No live effort starts at `Default`; Left stays at the boundary, then
    // two Right presses select `high` without wrapping.
    expect(writes[0]).toMatchObject({ reasoningEffort: 'high' as never })
  })

  it('/effort direct: valid level, default, and the invalid-level listing', async () => {
    const { ctx, agent, writes } = await mount()
    const execution = await ctx.commands.execute(agent, '/effort low', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'Thinking set to low' })
    expect(writes[0]).toMatchObject({ reasoningEffort: 'low' as never })

    const back = await ctx.commands.execute(agent, '/effort default', [], signal())
    expect(back?.result).toEqual({ kind: 'success', text: 'Thinking set to provider default' })

    const bogus = await ctx.commands.execute(agent, '/effort bogus', [], signal())
    expect(bogus?.result).toEqual({
      kind: 'error',
      text: 'unsupported thinking effort "bogus" for mock: available: default, low, high',
    })
  })

  it('/model answers "Already using" when nothing changes', async () => {
    const preset = fakeModelRef({ provider: 'mock', model: 'mock', reasoningEffort: 'high' as never })
    const { ctx, agent } = await mount({ modelRef: preset.ref })
    const execution = await ctx.commands.execute(agent, '/effort high', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'Already using mock (mock)' })
  })

  it('/model works without the default-model service and says so', async () => {
    const { ctx, agent } = await mount({ defaults: false })
    const execution = await ctx.commands.execute(agent, '/model mock-pro', [], signal())
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'Switched to mock-pro (mock) — default not saved: no default-model service',
    })
  })

  it('/model reports an ambiguity the live provider cannot resolve', async () => {
    const { ctx, agent } = await mount({
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
        models: {
          alpha: [{ id: 'shared', name: 'Shared' }],
          beta: [{ id: 'shared', name: 'Shared' }],
        },
      },
    })
    const execution = await ctx.commands.execute(agent, '/model shared', [], signal())
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'ambiguous model id: shared (alpha/shared, beta/shared)',
    })
  })

  it('/model and /effort report a missing UI registry without requiring a renderer', async () => {
    const ctx = new Context()
    new InteractionStateService(ctx, DEFAULT_SETTINGS)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('llm', fakeLlm())
    const session = ctx.sessions.create(SessionId('no-display'))
    const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
    const fake = fakeModelRef({ provider: 'mock', model: 'mock' })
    ctx.provide('testSession', { current: agent, modelRef: fake.ref })
    provideModelBoundary(ctx, agent, fake.ref)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'mock', model: 'mock' }),
      saveSelection: vi.fn(),
    } as unknown as AgentDefaultModelConfig)
    registerModelCommands(ctx)
    expect((await ctx.commands.execute(agent, '/model', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'model picker is unavailable' })
    expect((await ctx.commands.execute(agent, '/effort', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'model picker is unavailable' })
    await ctx.fiber.dispose()
  })

  it('/effort guards: no session and no llm service', async () => {
    const { ctx, agent } = await mount({ attach: false })
    expect((await ctx.commands.execute(agent, '/effort', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'no session is live yet' })
    await ctx.fiber.dispose()

  })

  it('/effort guards the llm service before resolving', async () => {
    const ctx = new Context()
    new InteractionStateService(ctx, DEFAULT_SETTINGS)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const session = ctx.sessions.create(SessionId('effort-no-llm'))
    const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
    const fake = fakeModelRef({ provider: 'mock', model: 'mock' })
    ctx.provide('testSession', { current: agent, modelRef: fake.ref })
    provideModelBoundary(ctx, agent, fake.ref)
    registerModelCommands(ctx)
    expect((await ctx.commands.execute(agent, '/effort', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'the llm service is unavailable' })
    await ctx.fiber.dispose()
  })

  it('cancels the pickers with Escape without committing', async () => {
    const { ctx, screen, agent, writes } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    overlay(screen).handleInput(KEY.escape)
    await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')).toBeUndefined())
    await ctx.commands.execute(agent, '/effort', [], signal())
    overlay(screen).handleInput(KEY.escape)
    await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')).toBeUndefined())
    expect(writes).toEqual([])
    expect(notices).toEqual([])
  })

  it('returns quietly when the tree unloads while the catalog is in flight', async () => {
    let release: (models: { id: string, name: string }[]) => void = () => {}
    const gate = new Promise<void>(resolve => { release = () => resolve([{ id: 'mock', name: 'Mock' }]) })
    const llm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => { await gate; return [{ id: 'mock', name: 'Mock' }] },
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
    } as unknown as LlmRuntime
    const { ctx, agent, screen, fiber } = await mount({ llm })
    const pending = ctx.commands.execute(agent, '/model', [], signal())
    await fiber.dispose()
    release([])
    expect((await pending)?.result).toEqual({ kind: 'success' })
    expect(screen.overlays).toHaveLength(0)
  })

  it('returns quietly when the tree unloads while the model metadata is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const llm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => { await gate; return {} },
    } as unknown as LlmRuntime
    const { ctx, agent, screen, fiber } = await mount({ llm })
    const pending = ctx.commands.execute(agent, '/effort', [], signal())
    await fiber.dispose()
    release()
    expect((await pending)?.result).toEqual({ kind: 'success' })
    expect(screen.overlays).toHaveLength(0)
  })

  it('/model falls back to the model id for an unnamed catalog entry', async () => {
    const { ctx, screen, agent } = await mount({
      catalog: { models: { mock: [{ id: 'mock', name: '' }] } },
    })
    await ctx.commands.execute(agent, '/model', [], signal())
    const rows = overlay(screen).render?.(60) ?? []
    expect(rows.some(row => row.includes('mock'))).toBe(true)
  })

  it('/model commits an effort-less pick without the effort key', async () => {
    const { ctx, agent, writes } = await mount({ catalog: { reasoning: null } })
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-pro')
    expect(options.form({ pagePath: [], formId: 'model-options' })?.definition.fields).toEqual([])
    options.invoke('default')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect('reasoningEffort' in (writes[0] ?? {})).toBe(false)
  })

  it('/model and /effort suppress the notice when the tree unloaded before the commit', async () => {
    const { ctx, agent, writes, fiber } = await mount()
    await ctx.commands.execute(agent, '/model', [], signal())
    const options = await selectModel(ctx, 'mock', 'mock-pro')
    await fiber.dispose()
    options.invoke('default')
    await new Promise(resolve => setImmediate(resolve))
    expect(writes).toEqual([])
    expect(notices).toEqual([])
  })

  it('/model and /effort suppress late commit notices after the tree unloads', async () => {
    for (const command of ['model', 'effort'] as const) {
      notices = []
      const mounted = await mount()
      let resolveSelection: (value: { selected: ModelSelection }) => void = () => {}
      const selectModelCall = vi.fn(() => new Promise<{ selected: ModelSelection }>(resolve => {
        resolveSelection = resolve
      }))
      ;(mounted.ctx.get('sessionController') as unknown as { selectModel: unknown }).selectModel = selectModelCall
      await mounted.ctx.commands.execute(mounted.agent, `/${command}`, [], signal())
      const options = command === 'model'
        ? await selectModel(mounted.ctx, 'mock', 'mock-pro')
        : mounted.ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
      options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'low')
      options.invoke('session')
      await vi.waitFor(() => { expect(selectModelCall).toHaveBeenCalledOnce() })
      await mounted.fiber.dispose()
      resolveSelection({ selected: { provider: 'mock', model: command === 'model' ? 'mock-pro' : 'mock', reasoningEffort: 'low' as never } })
      await new Promise(resolve => setImmediate(resolve))
      expect(notices).toEqual([])
    }
  })

  it('pickers seed from a live effort', async () => {
    const preset = fakeModelRef({ provider: 'mock', model: 'mock', reasoningEffort: 'low' as never })
    const { ctx, agent } = await mount({ modelRef: preset.ref })
    await ctx.commands.execute(agent, '/model', [], signal())
    const modelOptions = await selectModel(ctx)
    expect(modelOptions.form({ pagePath: [], formId: 'model-options' })?.fields.effort?.value).toBe('low')
    ctx.mayflyOverlays.close('mayfly.model.options')
    await ctx.commands.execute(agent, '/effort', [], signal())
    expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')?.form({ pagePath: [], formId: 'model-options' })?.fields.effort?.value).toBe('low')
  })

  it('/effort panel commits the default segment directly', async () => {
    const preset = fakeModelRef({ provider: 'mock', model: 'mock', reasoningEffort: 'high' as never })
    const { ctx, agent } = await mount({ modelRef: preset.ref })
    await ctx.commands.execute(agent, '/effort', [], signal())
    const options = ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'default')
    options.invoke('default')
    await vi.waitFor(() => { expect(preset.writes).toHaveLength(1) })
    expect('reasoningEffort' in (preset.writes[0] ?? {})).toBe(false)
  })

  it('stringifies a non-Error default-save failure', async () => {
    const { ctx, agent } = await mount({
      defaults: { selection: { provider: 'mock', model: 'mock' }, saveError: 'plain failure' as never },
    })
    const execution = await ctx.commands.execute(agent, '/model mock-pro', [], signal())
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'Switched to mock-pro (mock) — failed to save default: plain failure',
    })
  })

  it('/effort explicit session-only action leaves the default untouched', async () => {
    const { ctx, agent, saveSelection, writes } = await mount()
    await ctx.commands.execute(agent, '/effort', [], signal())
    const options = ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'low')
    options.invoke('session')
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect(saveSelection).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })
})

describe('cycleSessionModel (the Alt+M hotkey)', () => {
  it('cycles to the provider\'s next model through the session-only channel', async () => {
    const { ctx, writes, saveSelection } = await mount()
    await cycleSessionModel(ctx, modelListCache)
    expect(writes).toEqual([{ provider: 'mock', model: 'mock-pro' }])
    // A one-press switch never rewrites the persisted default.
    expect(saveSelection).not.toHaveBeenCalled()
    expect(notices).toEqual(['Switched to mock-pro (mock) · session only'])
  })

  it('drops the reasoning effort, matching the /model <id> direct switch', async () => {
    const fake = fakeModelRef({ provider: 'mock', model: 'mock', reasoningEffort: 'high' as never })
    const { ctx } = await mount({ modelRef: fake.ref })
    await cycleSessionModel(ctx, modelListCache)
    expect(fake.writes).toEqual([{ provider: 'mock', model: 'mock-pro' }])
  })

  it('wraps around to the first model and reuses the cached listing', async () => {
    const llm = fakeLlm()
    const listModels = vi.fn(llm.listModels)
    const { ctx } = await mount({ llm: { ...llm, listModels } as unknown as LlmRuntime })
    await cycleSessionModel(ctx, modelListCache)
    await cycleSessionModel(ctx, modelListCache)
    // mock → mock-pro, then the wrap back to mock — one listing for both.
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(notices[1]).toBe('Switched to mock (mock) · session only')
  })

  it('reports already-using on a single-model provider without touching the default', async () => {
    const { ctx, saveSelection } = await mount({
      catalog: { models: { mock: [{ id: 'mock', name: 'Mock' }] } },
    })
    await cycleSessionModel(ctx, modelListCache)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(notices).toEqual(['Already using mock (mock) · session only'])
  })

  it('declines when the provider advertises no models', async () => {
    const { ctx } = await mount({ catalog: { models: { mock: [] } } })
    await cycleSessionModel(ctx, modelListCache)
    expect(notices).toEqual(['the current provider advertises no models'])
  })

  it('cycles to the first advertised model when the current one left the list', async () => {
    const fake = fakeModelRef({ provider: 'mock', model: 'gone' })
    const { ctx } = await mount({
      modelRef: fake.ref,
      catalog: { models: { mock: [{ id: 'other', name: 'Other' }, { id: 'mock-pro', name: 'Mock Pro' }] } },
    })
    await cycleSessionModel(ctx, modelListCache)
    expect(fake.writes).toEqual([{ provider: 'mock', model: 'other' }])
  })

  /**
   * A bare context with only `mayflySession` (and an optional llm): no
   * screen/theme/components, so the failure notice travels unpainted.
   */
  async function bareContext(llm?: LlmRuntime): Promise<Context> {
    const ctx = new Context()
    new PromptEditorController(ctx)
    const agent = { id: 'bare', session: { events: [] }, status: 'idle' } as unknown as Agent
    provideModelBoundary(ctx, agent, fakeModelRef({ provider: 'mock', model: 'mock' }).ref)
    if (llm !== undefined) ctx.provide('llm', llm)
    setSharedEditor(ctx, {
      editor: { focused: false, render: () => [], invalidate: () => {} } as never,
      submitPrompt: () => {},
      report: (_id, feedback) => { notices.push(feedback.message) },
    })
    return ctx
  }

  it('declines without the llm service, unpainted', async () => {
    const ctx = await bareContext()
    await cycleSessionModel(ctx, modelListCache)
    expect(notices).toEqual(['the llm service is unavailable'])
  })

  it('flashes the listing failure unpainted on a display-less host', async () => {
    const ctx = await bareContext(fakeLlm({ failListFor: ['mock'] }))
    await cycleSessionModel(ctx, modelListCache)
    expect(notices).toEqual([`could not list the provider's models: catalog down`])
  })

  it('flashes the listing failure and retries on the next press', async () => {
    const llm = fakeLlm({ failListFor: ['mock'] })
    const { ctx } = await mount({ llm })
    await cycleSessionModel(ctx, modelListCache)
    expect(notices[0]).toContain("could not list the provider's models")
    expect(notices[0]).toContain('catalog down')
  })

  it('declines without a live session', async () => {
    const { ctx } = await mount({ attach: false })
    await cycleSessionModel(ctx, modelListCache)
    expect(notices).toEqual(['no session is live yet'])
  })

  it('uses a silent fallback when neither reporter nor shared editor exists', async () => {
    const ctx = new Context()
    await expect(cycleSessionModel(ctx, createModelListCache())).resolves.toBeUndefined()
  })
})

describe('direct model picker boundaries', () => {
  it('reports missing sessions and focuses existing model and option pickers', async () => {
    const detached = await mount({ attach: false })
    expect(await openModelPicker(detached.ctx, signal())).toEqual({ kind: 'error', text: 'no session is live yet' })

    const bench = await mount()
    expect(await openModelPicker(bench.ctx, signal())).toEqual({ kind: 'success' })
    const root = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')!
    const focus = root.focusRevision
    expect(await openModelPicker(bench.ctx, signal())).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === root.id)!.focusRevision).toBeGreaterThan(focus)
    const context = { surfaceId: root.id, operationId: 'select', source: root.source, revision: root.revision, signal: signal(), report: vi.fn() }
    expect(await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: ['missing'] }, context)).toMatchObject({ kind: 'failed' })
    const selected = JSON.stringify(['mock', 'mock'])
    await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [selected] }, context)
    const options = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.model.options')!
    const optionFocus = options.focusRevision
    await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [selected] }, context)
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === options.id)!.focusRevision).toBeGreaterThan(optionFocus)
  })

  it('filters providers and waits once for a newly visible route', async () => {
    const base = fakeLlm({ providers: [{ id: 'other', name: 'Other' }, { id: 'mock', name: '' }] })
    let reads = 0
    const llm = { ...base, listProviders: () => ++reads === 1 ? [] : [{ id: 'other', name: 'Other' }, { id: 'mock', name: '' }] } as unknown as LlmRuntime
    const bench = await mount({ llm })
    expect(await openModelPicker(bench.ctx, signal(), 'mock')).toEqual({ kind: 'success' })
    const node = JSON.stringify(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')!.node)
    expect(node).toContain('"label":"mock/Mock"')
    expect(node).not.toContain('Other')
  })

  it('times out a provider filter without sleeping after the deadline', async () => {
    const base = fakeLlm({ providers: [] })
    const bench = await mount({ llm: { ...base, listProviders: () => [] } as unknown as LlmRuntime })
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2_000)
    expect(await openModelPicker(bench.ctx, signal(), 'missing')).toEqual({ kind: 'success' })
    now.mockRestore()
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(false)
  })

  it('returns quietly when Agent authority changes after catalog loading', async () => {
    const bench = await mount()
    const list = Promise.withResolvers<{ id: string, name: string }[]>()
    vi.spyOn(bench.ctx.llm, 'listModels').mockReturnValueOnce(list.promise as never)
    const pending = openModelPicker(bench.ctx, signal())
    ;(bench.ctx.get('testSession') as { current: Agent | null }).current = null
    list.resolve([{ id: 'mock', name: 'Mock' }])
    expect(await pending).toEqual({ kind: 'success' })
  })

  it('uses model ids for blank provider names and reports unavailable defaults for effort changes', async () => {
    const llm = fakeLlm({ providers: [{ id: 'mock', name: '' }] })
    const bench = await mount({ llm, defaults: false })
    await openModelPicker(bench.ctx, signal())
    expect(JSON.stringify(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')!.node)).toContain('"label":"mock/Mock"')
    expect((await bench.ctx.commands.execute(bench.agent, '/effort default', [], signal()))?.result.kind).toBe('error')
    expect((await bench.ctx.commands.execute(bench.agent, '/effort low', [], signal()))?.result.kind).toBe('error')
  })

  it('reports an unavailable catalog and filter failures or cancellation', async () => {
    const unavailable = await mount()
    unavailable.ctx.set('llm', undefined as never)
    expect(await openModelPicker(unavailable.ctx, signal())).toEqual({ kind: 'error', text: 'the llm service is unavailable' })

    const throwing = await mount({ llm: { ...fakeLlm(), listProviders: () => { throw new Error('provider list failed') } } as unknown as LlmRuntime })
    expect(await openModelPicker(throwing.ctx, signal(), 'mock')).toEqual({ kind: 'error', text: 'provider list failed' })

    const cancelled = await mount({ llm: { ...fakeLlm(), listProviders: () => [] } as unknown as LlmRuntime })
    const controller = new AbortController()
    const pending = openModelPicker(cancelled.ctx, controller.signal, 'missing')
    controller.abort()
    expect(await pending).toEqual({ kind: 'success' })
  })

  it('reports a missing session controller during model option commit', async () => {
    const bench = await mount()
    await openModelPicker(bench.ctx, signal())
    const root = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.models')!
    const context = { surfaceId: root.id, operationId: 'select', source: root.source, revision: root.revision, signal: signal(), report: vi.fn() }
    await root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [JSON.stringify(['mock', 'mock'])] }, context)
    bench.ctx.set('sessionController', undefined as never)
    const options = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.invoke('session')
    await vi.waitFor(() => expect(options.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'no session is live yet' })])))
  })

  it('reports an Agent lost after effort metadata resolves', async () => {
    const bench = await mount()
    let reads = 0
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads === 1 ? bench.agent : null)
    const command = bench.ctx.commands.find(bench.agent, 'effort')!
    expect(await command.handler({ rawInput: '', signal: signal() } as never)).toEqual({ kind: 'error', text: 'no session is live yet' })
  })
})
