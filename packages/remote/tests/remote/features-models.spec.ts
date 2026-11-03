import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelSelection,
} from '@deepseek-ai/dsh-api-remotes/client'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteFeatureContext } from '../../src/remote/features/contracts.ts'
import {
  currentRemoteModelSelection,
  formatRemoteContextWindow,
  RemoteModelsController,
  remoteModelRows,
  remoteModelSelection,
  type RemoteModelCatalogDetails,
} from '../../src/remote/features/models.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))

/** One model row as the Host catalog carries it. */
function model(id: string, overrides: Partial<ModelCatalogModel> = {}): ModelCatalogModel {
  return { id, name: id, ...overrides }
}

/** One model selection with an optional branded reasoning effort. */
function selection(provider: string, id: string, effort?: string): ModelSelection {
  return {
    provider,
    model: id,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

/** A Host catalog; callers override only the fields a decision observes. */
function catalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    default: selection('deepseek', 'chat'),
    routableProviders: ['deepseek'],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', { name: 'DeepSeek Chat' })] }],
    failures: [],
    ...overrides,
  }
}

/** Host-merged context/effort metadata the source contributes for this generation. */
function detailsOf(entries: Readonly<Record<string, {
  readonly contextWindow?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
}>>): RemoteModelCatalogDetails {
  const lookup = (provider: string, id: string) => entries[`${provider}/${id}`]
  return {
    contextWindow: (provider, id) => lookup(provider, id)?.contextWindow,
    efforts: (provider, id) => lookup(provider, id)?.efforts,
    defaultEffort: (provider, id) => lookup(provider, id)?.defaultEffort,
  }
}

/** Deferred answer for a Host read a test keeps pending across a state change. */
function deferred<T>(): { readonly promise: Promise<T>, resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Translate with the `{name}` interpolation the pickers rely on. */
const translate = vi.fn((key: string, params?: Readonly<Record<string, string | number>>) => params === undefined
  ? key
  : key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name])))

interface FixtureOptions {
  readonly access?: 'interactive' | 'resumable' | 'readonly'
  readonly catalog?: ModelCatalog
  readonly details?: RemoteModelCatalogDetails
  readonly current?: boolean
  readonly attached?: boolean
  readonly projection?: unknown
  readonly defaultSelection?: ModelSelection
  readonly withDefaultModel?: boolean
  readonly withSource?: boolean
  readonly observeCatalog?: boolean
}

function fixture(options: FixtureOptions = {}) {
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  const defaultCatalog = options.catalog ?? catalog()
  const modelCatalog = vi.fn(async (): Promise<unknown> => ({ ok: true, value: defaultCatalog }))
  const selectModel = vi.fn(async (request: Record<string, unknown>): Promise<unknown> => ({
    ok: true,
    value: {
      selected: selection(
        String(request.provider),
        String(request.model),
        typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined,
      ),
    },
  }))
  const listeners = new Set<() => void>()
  const snapshot = (): unknown => options.projection ?? { next: { provider: 'deepseek', model: 'chat' } }
  const projection = {
    getSnapshot: vi.fn(snapshot),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  const faceOf = vi.fn(() => projection)
  const binding = { session: { projections: { faceOf } } }
  const client = {
    key: HostKey('local'),
    remote: { session: { modelCatalog, selectModel } },
  } as unknown as HostClient
  const attached = options.attached ?? true
  const current = vi.fn(() => (options.current === false ? undefined : { ref, client, binding, ...options.access === undefined ? {} : { access: options.access } }))
  const hosts = {
    current,
    list: vi.fn(() => (attached ? [client] : [])),
    subscribe: vi.fn(() => () => {}),
  }
  const open = vi.fn()
  const overlays = { open, close: vi.fn() }
  const notice = { set: vi.fn() }
  const focus = vi.fn(() => false)
  const context = {
    ctx: { mayflyOverlays: { focus } },
    screen: { requestRender: vi.fn() },
    components: { truncateToWidth: (text: string, width: number) => text.slice(0, width) },
    colors: {
      primary: (text: string) => text,
      accent: (text: string) => text,
      muted: (text: string) => text,
    },
    overlays,
    hosts,
    notice,
    t: translate,
    subscribeLocale: vi.fn(() => () => {}),
    presentation: {},
  } as unknown as RemoteFeatureContext
  const source = options.withSource === false
    ? undefined
    : { load: vi.fn(async () => options.details) }
  const defaultModel = options.withDefaultModel === false
    ? undefined
    : {
        read: vi.fn(async () => options.defaultSelection ?? selection('deepseek', 'chat')),
        select: vi.fn(async (_client: HostClient, next: ModelSelection) => next),
      }
  const opened: { options: RemoteBrowserOptions, lease: { close: ReturnType<typeof vi.fn>, refresh: ReturnType<typeof vi.fn>, closed: boolean } }[] = []
  mocks.open.mockImplementation((_context: unknown, options: RemoteBrowserOptions) => {
    const lease = { closed: false, close: vi.fn(), refresh: vi.fn() }
    opened.push({ options, lease })
    return lease
  })
  const catalogObserved = options.observeCatalog === true ? vi.fn() : undefined
  const controller = new RemoteModelsController(context, source, defaultModel, catalogObserved)
  const browser = (index = 0): RemoteBrowserOptions => opened[index]!.options
  const render = (index = 0): string => JSON.stringify(browser(index).view())
  const act = async (event: Record<string, unknown>, index = 0, signal = new AbortController().signal) => await browser(index).action!(event as unknown as MayflyUiActionEvent, { signal, report: vi.fn() } as unknown as MayflyUiEventContext)
  return {
    context, controller, client, ref, binding, projection, faceOf, listeners,
    modelCatalog, selectModel, hosts, current, notice, source, defaultModel,
    overlays, opened, browser, render, act, catalogObserved, focus,
  }
}

describe('remoteModelRows', () => {
  it('refuses readonly direct, cycle, command and picker writes without falling back to Host defaults', async () => {
    const test = fixture({ access: 'readonly', details: detailsOf({ 'deepseek/chat': { efforts: ['high'] } }) })
    await expect(test.controller.select(test.ref, selection('deepseek', 'chat', 'high'))).rejects.toThrow('read-only')
    await test.controller.cycle()
    await test.controller.open('chat')
    await test.controller.effort('high')
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])], segmentId: 'high' })).toMatchObject({ kind: 'failed', message: 'This conversation is read-only' })
    await test.controller.effort()
    expect(await test.act({ kind: 'slider-accept', controlId: 'effort', value: 'high' }, 1)).toMatchObject({ kind: 'failed', message: 'This conversation is read-only' })
    expect(test.selectModel).not.toHaveBeenCalled()
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it.each(['interactive', 'resumable'] as const)('preserves model writes for %s access', async access => {
    const test = fixture({ access })
    await test.controller.select(test.ref, selection('deepseek', 'chat', 'high'))
    expect(test.selectModel).toHaveBeenCalledOnce()
    test.controller.dispose()
  })

  it('rejects a default-model commit when a readonly Session appears during its preceding read', async () => {
    const test = fixture({ current: false, details: detailsOf({ 'deepseek/chat': { efforts: ['high'] } }) })
    await test.controller.effort()
    const response = Promise.withResolvers<ModelSelection>()
    test.defaultModel!.read.mockReturnValueOnce(response.promise)
    const pending = test.act({ kind: 'slider-accept', controlId: 'effort', value: 'high' })
    test.current.mockReturnValue({ ref: test.ref, client: test.client, binding: test.binding, access: 'readonly' })
    response.resolve(selection('deepseek', 'chat'))
    expect(await pending).toMatchObject({ kind: 'cancelled' })
    expect(test.selectModel).not.toHaveBeenCalled()
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    test.controller.dispose()
  })
  it.each(['model', 'effort'] as const)('suppresses a late %s picker write after its action is cancelled while the panel remains mounted', async kind => {
    for (const rejected of [false, true]) {
      const test = fixture({ details: detailsOf({ 'deepseek/chat': { efforts: ['high'] } }) })
      if (kind === 'model') await test.controller.open()
      else await test.controller.effort()
      const response = Promise.withResolvers<unknown>()
      test.selectModel.mockReturnValueOnce(response.promise)
      const caller = new AbortController()
      const pending = test.act(kind === 'model'
        ? { kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])], segmentId: 'high' }
        : { kind: 'slider-accept', controlId: 'effort', value: 'high' }, 0, caller.signal)
      await vi.waitFor(() => { expect(test.selectModel).toHaveBeenCalledOnce() })
      caller.abort()
      expect(test.browser().isCurrent!()).toBe(true)
      if (rejected) response.reject(new Error('cancelled action failed'))
      else response.resolve({ ok: true, value: { selected: selection('deepseek', 'chat', 'high') } })
      expect(await pending).toEqual({ kind: 'cancelled', dismiss: true })
      expect(test.notice.set).not.toHaveBeenCalled()
      expect(test.opened[0]!.lease.close).not.toHaveBeenCalled()
      test.controller.dispose()
    }
  })

  it('does not send a default-model write when its picker action is cancelled during the preceding read', async () => {
    const test = fixture({ current: false, details: detailsOf({ 'deepseek/chat': { efforts: ['high'] } }) })
    await test.controller.effort()
    const response = Promise.withResolvers<ModelSelection>()
    test.defaultModel!.read.mockReturnValueOnce(response.promise)
    const caller = new AbortController()
    const pending = test.act({ kind: 'slider-accept', controlId: 'effort', value: 'high' }, 0, caller.signal)
    caller.abort()
    response.resolve(selection('deepseek', 'chat'))
    expect(await pending).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    expect(test.notice.set).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it.each(['model', 'effort'] as const)('refocuses the existing %s picker while retaining its original invocation and draft', async kind => {
    const test = fixture({ details: detailsOf({ 'deepseek/chat': { efforts: ['high'] } }) })
    const first = new AbortController()
    const second = new AbortController()
    const invoke = (signal: AbortSignal) => kind === 'model' ? test.controller.open('', undefined, signal) : test.controller.effort('', signal)
    await invoke(first.signal)
    expect(test.opened).toHaveLength(1)
    test.focus.mockReturnValue(true)
    test.modelCatalog.mockClear()
    await invoke(second.signal)
    expect(test.focus).toHaveBeenLastCalledWith(kind === 'model' ? 'mayfly.models' : 'mayfly.effort')
    expect(test.opened).toHaveLength(1)
    expect(test.modelCatalog).not.toHaveBeenCalled()
    second.abort()
    expect(test.opened[0]!.lease.close).not.toHaveBeenCalled()
    const cancelled = new AbortController(); cancelled.abort()
    test.focus.mockClear()
    await invoke(cancelled.signal)
    expect(test.focus).not.toHaveBeenCalled()
    first.abort()
    expect(test.opened[0]!.lease.close).toHaveBeenCalledOnce()
    test.controller.dispose()
  })

  it('retires cancelled command catalog reads before opening a picker or writing a Session or Host default', async () => {
    for (const current of [true, false]) {
      for (const name of ['model-picker', 'model-name', 'effort-picker', 'effort-name']) {
        const test = fixture({ current, observeCatalog: true })
        const pending = deferred<unknown>()
        test.modelCatalog.mockReturnValueOnce(pending.promise)
        const abort = new AbortController()
        const opening = name.startsWith('model')
          ? test.controller.open(name.endsWith('name') ? 'chat' : '', undefined, abort.signal)
          : test.controller.effort(name.endsWith('name') ? 'high' : '', abort.signal)
        abort.abort()
        pending.resolve({ ok: true, value: catalog() })
        await opening
        expect(test.opened).toHaveLength(0)
        expect(test.selectModel).not.toHaveBeenCalled()
        expect(test.defaultModel!.read).not.toHaveBeenCalled()
        expect(test.defaultModel!.select).not.toHaveBeenCalled()
        expect(test.catalogObserved).not.toHaveBeenCalled()
        expect(test.notice.set).not.toHaveBeenCalled()
        test.controller.dispose()
      }
    }
  })

  it('does no command I/O when already aborted and closes an accepted picker on caller cancellation', async () => {
    const test = fixture()
    const cancelled = new AbortController(); cancelled.abort()
    await test.controller.open('', undefined, cancelled.signal)
    await test.controller.effort('high', cancelled.signal)
    expect(test.modelCatalog).not.toHaveBeenCalled()
    const active = new AbortController()
    await test.controller.open('', undefined, active.signal)
    expect(test.opened).toHaveLength(1)
    active.abort()
    expect(test.opened[0]!.lease.close).toHaveBeenCalledOnce()
    expect(await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })).toMatchObject({ kind: 'cancelled' })
    expect(test.selectModel).not.toHaveBeenCalled()
    expect(test.listeners.size).toBe(0)
    test.controller.dispose()
  })

  it('does not write after cancellation while the sessionless default route is being resolved', async () => {
    const test = fixture({ current: false, observeCatalog: true })
    const pending = deferred<ModelSelection>()
    test.defaultModel!.read.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const selecting = test.controller.open('chat', undefined, abort.signal)
    await vi.waitFor(() => { expect(test.defaultModel!.read).toHaveBeenCalledOnce() })
    abort.abort()
    pending.resolve(selection('deepseek', 'chat'))
    await selecting
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    expect(test.catalogObserved).not.toHaveBeenCalled()
    expect(test.opened).toHaveLength(0)
    expect(test.notice.set).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it('flattens provider groups and prefers Host-merged metadata over the model own', () => {
    const merged = catalog({
      groups: [
        { id: 'deepseek', name: 'DeepSeek', models: [model('chat', {
          name: 'Chat',
          reasoning: { efforts: [{ id: 'own', name: 'Own' }], defaultEffort: 'own' },
        })] },
        { id: 'other', name: 'Other', models: [model('plain', { name: 'Plain' })] },
      ],
    })
    const rows = remoteModelRows(merged, selection('other', 'plain'), detailsOf({
      'deepseek/chat': { contextWindow: 131072, efforts: ['high', 'low'], defaultEffort: 'high' },
    }))

    expect(rows.map(row => [row.provider, row.providerLabel, row.model.id])).toEqual([
      ['deepseek', 'DeepSeek', 'chat'],
      ['other', 'Other', 'plain'],
    ])
    expect(rows[0]).toMatchObject({
      contextWindow: 131072,
      efforts: ['high', 'low'],
      defaultEffort: 'high',
      current: false,
    })
    // The second row has no merged and no model metadata: nothing is invented.
    expect(rows[1]).not.toHaveProperty('contextWindow')
    expect(rows[1]).not.toHaveProperty('defaultEffort')
    expect(rows[1]!.efforts).toEqual([])
    expect(rows[0]!.key).toBe(JSON.stringify(['deepseek', 'chat']))
    expect(rows[1]!.current).toBe(true)
  })

  it('falls back to the model own reasoning metadata when the Host merges none', () => {
    const rows = remoteModelRows(catalog({
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', {
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      })] }],
    }), selection('deepseek', 'chat'))
    expect(rows[0]!.efforts).toEqual(['low', 'high'])
    expect(rows[0]!.defaultEffort).toBe('low')
    expect(rows[0]!.current).toBe(true)
  })
})

describe('remote model wire values', () => {
  it('parses only string provider/model routes and drops non-string efforts', () => {
    expect(remoteModelSelection({ provider: 'deepseek', model: 'chat', reasoningEffort: 3 })).toEqual({ provider: 'deepseek', model: 'chat' })
    expect(remoteModelSelection({ provider: 1, model: 'chat' })).toBeUndefined()
    expect(remoteModelSelection(null)).toBeUndefined()
    expect(remoteModelSelection({ provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })).toEqual({
      provider: 'deepseek', model: 'chat', reasoningEffort: 'high',
    })
  })

  it('prefers next over lastUsed over the catalog default', () => {
    const hostCatalog = catalog()
    expect(currentRemoteModelSelection({
      next: { provider: 'a', model: 'next' },
      lastUsed: { provider: 'b', model: 'old' },
    }, hostCatalog)).toEqual({ provider: 'a', model: 'next' })
    expect(currentRemoteModelSelection({ lastUsed: { provider: 'b', model: 'old' } }, hostCatalog))
      .toEqual({ provider: 'b', model: 'old' })
    expect(currentRemoteModelSelection({}, hostCatalog)).toBe(hostCatalog.default)
  })

  it('formats context sizes in binary units without a trailing zero', () => {
    expect(formatRemoteContextWindow(512)).toBe('512')
    expect(formatRemoteContextWindow(1024)).toBe('1k')
    expect(formatRemoteContextWindow(1536)).toBe('1.5k')
    expect(formatRemoteContextWindow(131072)).toBe('128k')
    expect(formatRemoteContextWindow(10 * 1024 * 1024)).toBe('10m')
  })
})

describe('RemoteModelsController reference wire UI', () => {
  it('publishes only admitted native catalogs to the selected Host metadata consumer', async () => {
    const test = fixture({ observeCatalog: true })
    expect(await test.controller.catalog(test.client)).toBeDefined()
    expect(test.catalogObserved).toHaveBeenLastCalledWith(test.client, await test.controller.catalog(test.client))
    await test.controller.open()
    const opened = test.catalogObserved!.mock.calls.length
    await test.act({ kind: 'activate', actionId: 'refresh' })
    expect(test.catalogObserved).toHaveBeenCalledTimes(opened + 1)
    test.controller.dispose()
    const settled = test.catalogObserved!.mock.calls.length
    expect(await test.controller.catalog(test.client)).toBeUndefined()
    expect(test.catalogObserved).toHaveBeenCalledTimes(settled)
  })

  it('never publishes a catalog that settles after selection retirement', async () => {
    const test = fixture({ observeCatalog: true })
    const result = deferred<unknown>()
    test.modelCatalog.mockReturnValueOnce(result.promise)
    const pending = test.controller.open()
    test.controller.dispose()
    result.resolve({ ok: true, value: catalog() })
    await pending
    expect(test.catalogObserved).not.toHaveBeenCalled()
  })

  it('opens the reference filterable numbered picker with grouped rows and live thinking segment', async () => {
    const test = fixture({ details: detailsOf({ 'deepseek/chat': { contextWindow: 131072, efforts: ['low', 'high'], defaultEffort: 'low' } }) })
    await test.controller.open()
    expect(test.browser().id).toBe('mayfly.models')
    expect(test.browser().scope).toEqual({ kind: 'session', sessionId: test.ref.sessionId })
    expect(test.render()).toContain('Select a model')
    expect(test.render()).toContain('128k context')
    const node = test.browser().view() as unknown as { child: { id: string, numbered: string, filterable: boolean, items: readonly unknown[] } }
    expect(node.child).toMatchObject({ id: 'selection', numbered: 'focus', filterable: true })
    expect(node.child.items[0]).toMatchObject({ label: 'DeepSeek/DeepSeek Chat', group: 'DeepSeek', current: true, segment: { inheritedId: 'low' } })
    expect(test.faceOf).toHaveBeenCalledWith('modelSelection')
    test.controller.dispose()
  })

  it('commits a structured selection and returns dismissal only after native confirmation', async () => {
    const test = fixture({ details: detailsOf({ 'deepseek/chat': { efforts: ['low', 'high'] } }) })
    await test.controller.open()
    const result = await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])], segmentId: 'high' })
    expect(test.selectModel).toHaveBeenCalledWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
    expect(result).toEqual({ kind: 'completed', dismiss: true })
    expect(test.notice.set).toHaveBeenCalledWith('Thinking set to high', 'success')
    test.controller.dispose()
  })

  it('omits an unpinned effort and refuses unavailable rows or levels', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: ['gone'] })).toMatchObject({ kind: 'failed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])], segmentId: 'unsupported' })).toMatchObject({ kind: 'failed' })
    expect(test.selectModel).not.toHaveBeenCalled()
    await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })
    expect(test.selectModel).not.toHaveBeenCalled()
    expect(test.notice.set).toHaveBeenCalledWith('Already using chat (deepseek)', 'success')
    test.controller.dispose()
  })

  it('keeps failed writes visible and never retries an unknown outcome', async () => {
    const test = fixture({ projection: { next: selection('deepseek', 'previous') } })
    test.selectModel.mockRejectedValueOnce(new Error('connection ended'))
    await test.controller.open()
    const result = await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })
    expect(result).toEqual({ kind: 'failed', message: 'connection ended' })
    expect(test.selectModel).toHaveBeenCalledOnce()
    expect(test.notice.set).not.toHaveBeenCalled()
    expect(test.opened[0]!.lease.close).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it('uses default-model writes without a Session and preserves the exact route', async () => {
    const test = fixture({ current: false })
    await test.controller.open()
    expect(test.browser().scope).toEqual({ kind: 'app', targetId: 'model-selection' })
    await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    expect(test.notice.set).toHaveBeenCalledWith('Already using chat (deepseek)', 'success')
    expect(test.selectModel).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it('accepts only exact model ids, resolves duplicates under the current provider, and reports exact ambiguous candidates', async () => {
    const advertised = catalog({ groups: [
      { id: 'first', name: 'First', models: [model('chat', { name: 'Display Chat' }), model('solo')] },
      { id: 'second', name: 'Second', models: [model('chat')] },
    ] })
    const test = fixture({ catalog: advertised })
    await test.controller.open('chat')
    expect(test.notice.set).toHaveBeenCalledWith('ambiguous model id: chat (first/chat, second/chat)', 'error')
    for (const argument of ['missing', 'CHAT', 'Display Chat', 'first/chat', 'cha']) {
      await test.controller.open(argument)
      expect(test.notice.set).toHaveBeenCalledWith(`unknown model: ${argument}`, 'error')
    }
    expect(test.selectModel).not.toHaveBeenCalled()
    await test.controller.open(' solo ')
    expect(test.selectModel).toHaveBeenCalledWith({ sessionId: test.ref.sessionId, provider: 'first', model: 'solo' })
    expect(test.opened).toHaveLength(0)
    test.controller.dispose()
    const duplicate = fixture({ catalog: advertised, projection: { next: selection('second', 'other', 'high') } })
    await duplicate.controller.open('chat')
    expect(duplicate.selectModel).toHaveBeenCalledWith({ sessionId: duplicate.ref.sessionId, provider: 'second', model: 'chat' })
    expect(duplicate.notice.set).toHaveBeenCalledWith('Switched to chat (second)', 'info')
    duplicate.controller.dispose()
  })

  it('does not create a default picker without its Host capability or an attached Host', async () => {
    const unavailable = fixture({ current: false, withDefaultModel: false })
    await unavailable.controller.open()
    expect(unavailable.opened).toHaveLength(0)
    expect(unavailable.notice.set).toHaveBeenCalledWith('Selecting the default model requires the Host defaultModel capability.', 'error')
    unavailable.controller.dispose()
    const detached = fixture({ attached: false })
    await detached.controller.open()
    expect(detached.opened).toHaveLength(0)
    expect(await detached.controller.catalog(detached.client)).toBeUndefined()
    detached.controller.dispose()
  })

  it('uses the reference effort slider and resets to the provider default without a key', async () => {
    const test = fixture({ catalog: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', { reasoning: { efforts: [{ id: 'low', name: 'Fast' }, { id: 'high', name: 'Smart' }], defaultEffort: 'low' } })] }] }) })
    await test.controller.effort()
    expect(test.browser().id).toBe('mayfly.effort')
    expect(test.render()).toContain('Faster')
    expect(test.render()).toContain('Smarter')
    expect(test.render()).toContain('provider default: low')
    expect(await test.act({ kind: 'slider-accept', controlId: 'effort', value: 'high' })).toEqual({ kind: 'completed', dismiss: true })
    expect(test.selectModel).toHaveBeenLastCalledWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
    await test.controller.effort('default')
    expect(test.notice.set).toHaveBeenLastCalledWith('Already using chat (deepseek)', 'info')
    await test.controller.effort('Smart')
    expect(test.selectModel).toHaveBeenLastCalledWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
    await test.controller.effort('DEFAULT')
    expect(test.notice.set).toHaveBeenCalledWith('unsupported thinking effort "DEFAULT" for chat: available: default, low, high', 'error')
    await test.controller.effort('unsupported')
    expect(test.notice.set).toHaveBeenCalledWith(expect.stringContaining('unsupported thinking effort'), 'error')
    test.controller.dispose()
  })

  it('reports direct switch failures once as errors while effort picker failures stay inline', async () => {
    const options = { catalog: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', { reasoning: { efforts: [{ id: 'high', name: 'Smart' }] } })] }] }) }
    for (const method of ['open', 'effort'] as const) {
      const test = fixture({ ...options, projection: { next: selection('deepseek', 'previous') } })
      if (method === 'effort') test.projection.getSnapshot.mockReturnValue({ next: selection('deepseek', 'chat') })
      test.selectModel.mockRejectedValueOnce(new Error('native switch refused'))
      await test.controller[method](method === 'open' ? 'chat' : 'high')
      expect(test.selectModel).toHaveBeenCalledOnce()
      expect(test.notice.set).toHaveBeenCalledExactlyOnceWith('native switch refused', 'error')
      expect(test.opened).toHaveLength(0)
      test.controller.dispose()
    }
    const picker = fixture(options)
    await picker.controller.effort()
    picker.selectModel.mockRejectedValueOnce(new Error('native effort refused'))
    expect(await picker.act({ kind: 'slider-accept', controlId: 'effort', value: 'high' })).toEqual({ kind: 'failed', message: 'native effort refused' })
    expect(picker.notice.set).not.toHaveBeenCalled()
    expect(picker.opened[0]!.lease.close).not.toHaveBeenCalled()
    picker.controller.dispose()
  })

  it('reports models without reasoning efforts without inventing slider levels', async () => {
    const test = fixture()
    await test.controller.effort()
    expect(test.opened).toHaveLength(0)
    expect(test.notice.set).toHaveBeenCalledWith('the current model exposes no reasoning efforts', 'error')
    test.controller.dispose()
  })

  it('resolves overlapping effort ids and labels in advertised order and keeps uppercase default explicit when offered', async () => {
    const test = fixture({ catalog: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', { reasoning: { efforts: [
      { id: 'first', name: 'Second' }, { id: 'second', name: 'Later' }, { id: 'custom', name: 'DEFAULT' },
    ] } })] }] }) })
    await test.controller.effort('second')
    expect(test.selectModel).toHaveBeenLastCalledWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'first' })
    await test.controller.effort('DEFAULT')
    expect(test.selectModel).toHaveBeenLastCalledWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'custom' })
    test.controller.dispose()
  })

  it('ignores a catalog answer for a replaced binding and drops late write feedback', async () => {
    const test = fixture()
    const read = deferred<unknown>()
    test.modelCatalog.mockReturnValueOnce(read.promise)
    const opening = test.controller.open()
    test.current.mockReturnValue({ ref: test.ref, client: test.client, binding: { session: { projections: { faceOf: test.faceOf } } } })
    read.resolve({ ok: true, value: catalog() })
    await opening
    expect(test.opened).toHaveLength(0)
    test.controller.dispose()

    const late = fixture({ projection: { next: selection('deepseek', 'previous') } })
    await late.controller.open()
    const response = deferred<unknown>()
    late.selectModel.mockReturnValueOnce(response.promise)
    const committing = late.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })
    late.controller.dispose()
    response.resolve({ ok: true, value: { selected: selection('deepseek', 'chat') } })
    expect(await committing).toMatchObject({ kind: 'cancelled' })
    expect(late.notice.set).not.toHaveBeenCalled()
  })

  it('uses the newest refresh and updates the live row from the native projection', async () => {
    const test = fixture()
    await test.controller.open()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    test.modelCatalog.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const older = test.act({ kind: 'activate', actionId: 'refresh' })
    const newer = test.act({ kind: 'activate', actionId: 'refresh' })
    second.resolve({ ok: true, value: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('new')] }] }) })
    await newer
    first.resolve({ ok: true, value: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('old')] }] }) })
    await older
    expect(test.render()).toContain('DeepSeek/new')
    expect(test.render()).not.toContain('DeepSeek/old')
    test.projection.getSnapshot.mockReturnValue({ next: { provider: 'deepseek', model: 'new' } })
    for (const listener of test.listeners) listener()
    expect(test.render()).toContain('"current":true')
    test.controller.dispose()
    expect(test.opened[0]!.lease.close).toHaveBeenCalledOnce()
    expect(test.listeners.size).toBe(0)
  })

  it('reports catalog failures and keeps native catalog/select methods exact-scoped', async () => {
    const test = fixture({ withSource: false })
    test.modelCatalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    await test.controller.open()
    expect(test.notice.set).toHaveBeenCalledWith('catalog unavailable', 'error')
    expect(await test.controller.catalog(test.client)).toMatchObject({ groups: expect.any(Array) })
    expect(await test.controller.select({ ...test.ref, host: HostKey('other') }, selection('deepseek', 'chat'))).toBeUndefined()
    expect(await test.controller.select(test.ref, selection('deepseek', 'chat'))).toEqual(selection('deepseek', 'chat'))
    test.controller.dispose()
  })

  it('keeps adapter-default provenance in native selection and renders an explicit pin only when present', async () => {
    const metadata = detailsOf({ 'deepseek/chat': { efforts: ['low', 'high'], defaultEffort: 'high' } })
    for (const pinned of [false, true]) {
      const test = fixture({ details: metadata, projection: { lastUsed: selection('deepseek', 'chat', pinned ? 'high' : undefined) } })
      await test.controller.open()
      const node = test.browser().view() as unknown as { child: { items: readonly { segment: { inheritedId?: string, selectedId?: string } }[] } }
      expect(node.child.items[0]!.segment).toEqual({ label: 'Thinking', options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }], inheritedId: 'high', ...pinned ? { selectedId: 'high' } : {} })
      expect(test.selectModel).not.toHaveBeenCalled()
      test.controller.dispose()
    }
  })

  it('fences native catalog and selection results and refuses missing, foreign, or unloaded scopes', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.modelCatalog.mockReturnValueOnce(pending.promise)
    const reading = test.controller.catalog(test.client)
    test.controller.dispose()
    pending.resolve({ ok: true, value: catalog() })
    expect(await reading).toBeUndefined()
    expect(await test.controller.select(test.ref, selection('deepseek', 'chat'))).toBeUndefined()
    expect(await test.controller.open()).toBeUndefined()
    expect(await test.controller.effort()).toBeUndefined()
    const missing = fixture({ current: false, attached: false })
    expect(await missing.controller.select(missing.ref, selection('deepseek', 'chat'))).toBeUndefined()
    await missing.controller.open()
    expect(missing.opened).toEqual([])
    missing.controller.dispose()
    const late = fixture()
    const result = deferred<unknown>()
    late.selectModel.mockReturnValueOnce(result.promise)
    const selecting = late.controller.select(late.ref, selection('deepseek', 'chat', 'high'))
    late.controller.dispose()
    result.resolve({ ok: true, value: { selected: selection('deepseek', 'chat', 'high') } })
    expect(await selecting).toBeUndefined()
  })

  it('ignores a missing selected row, missing model label, and a failed optional metadata source', async () => {
    const test = fixture({ catalog: catalog({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat', { name: '' }), model('other', { reasoning: { efforts: [{ id: 'high', name: 'High' }] } })] }] }) })
    test.source!.load.mockRejectedValueOnce(new Error('optional metadata unavailable'))
    await test.controller.open('', 'deepseek')
    expect(test.render()).toContain('DeepSeek/chat')
    expect(test.notice.set).not.toHaveBeenCalled()
    await test.act({ kind: 'dismiss' })
    test.projection.getSnapshot.mockReturnValue({ next: selection('deepseek', 'gone') })
    await test.controller.effort()
    expect(test.notice.set).toHaveBeenCalledWith('the current model exposes no reasoning efforts', 'error')
    test.controller.dispose()
  })

  it('admits only current effort actions and preserves exact Host writes including reset', async () => {
    const test = fixture({ projection: { next: selection('deepseek', 'chat', 'high') }, details: detailsOf({ 'deepseek/chat': { efforts: ['low', 'high'] } }) })
    await test.controller.effort()
    expect(test.render()).not.toContain('provider default:')
    expect(test.browser().isCurrent!()).toBe(true)
    expect(await test.act({ kind: 'activate', controlId: 'unrelated' })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'slider-accept', controlId: 'unrelated', value: 'low' })).toEqual({ kind: 'completed' })
    const cancelled = new AbortController(); cancelled.abort()
    const context = { signal: cancelled.signal } as MayflyUiEventContext
    expect(await test.browser().action!({ kind: 'slider-accept', controlId: 'effort', value: 'low', pagePath: [] }, context)).toEqual({ kind: 'cancelled' })
    expect(await test.act({ kind: 'slider-accept', controlId: 'effort', value: 'gone' })).toMatchObject({ kind: 'failed' })
    expect(await test.act({ kind: 'slider-accept', controlId: 'effort', value: null })).toEqual({ kind: 'completed', dismiss: true })
    expect(test.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: 'chat' })
    test.browser().onClosed!()
    expect(test.browser().isCurrent!()).toBe(false)
    expect(test.opened[0]!.lease.close).toHaveBeenCalledOnce()
    test.controller.dispose()
  })

  it('fences pending default reads before refresh and commit, including late failure feedback', async () => {
    const test = fixture({ current: false, details: detailsOf({ 'deepseek/chat': { efforts: ['low', 'high'], defaultEffort: 'low' } }) })
    await test.controller.open()
    const selected = deferred<ModelSelection>()
    test.defaultModel!.read.mockReturnValueOnce(selected.promise)
    const writing = test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])], segmentId: 'high' })
    test.controller.dispose()
    selected.resolve(selection('deepseek', 'chat'))
    expect(await writing).toMatchObject({ kind: 'cancelled' })
    expect(test.defaultModel!.select).not.toHaveBeenCalled()
    expect(await test.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })).toMatchObject({ kind: 'cancelled' })

    const late = fixture({ projection: { next: selection('deepseek', 'previous') } })
    await late.controller.open()
    const response = Promise.withResolvers<unknown>()
    late.selectModel.mockReturnValueOnce(response.promise)
    const failed = late.act({ kind: 'selection-accept', controlId: 'selection', selectedIds: [JSON.stringify(['deepseek', 'chat'])] })
    late.controller.dispose()
    response.reject(new Error('obsolete transport failure'))
    expect(await failed).toMatchObject({ kind: 'cancelled' })
    expect(late.notice.set).not.toHaveBeenCalled()
  })

  it('refreshes Session-independent defaults and drops refreshes whose default read outlives the owner', async () => {
    const test = fixture({ current: false })
    await test.controller.open()
    await test.act({ kind: 'activate', actionId: 'refresh' })
    const pending = deferred<ModelSelection>()
    test.defaultModel!.read.mockReturnValueOnce(pending.promise)
    const refreshing = test.act({ kind: 'activate', actionId: 'refresh' })
    await vi.waitFor(() => { expect(test.defaultModel!.read).toHaveBeenCalledTimes(3) })
    test.controller.dispose()
    pending.resolve(selection('deepseek', 'chat'))
    await refreshing
    expect(test.opened[0]!.lease.refresh).toHaveBeenCalledOnce()
  })

  it('checks cancellation before selection actions and ignores native projection notifications already queued on close', async () => {
    const test = fixture()
    await test.controller.open()
    const notify = [...test.listeners][0]!
    const cancelled = new AbortController(); cancelled.abort()
    expect(await test.browser().action!({ kind: 'selection-accept', controlId: 'selection', selectedIds: ['gone'], pagePath: [] }, { signal: cancelled.signal } as MayflyUiEventContext)).toEqual({ kind: 'cancelled' })
    test.browser().onClosed!()
    notify()
    expect(test.opened[0]!.lease.refresh).not.toHaveBeenCalled()
    test.controller.dispose()
  })

  it('keeps an older refresh error from overwriting a newer successful native catalog', async () => {
    const test = fixture()
    await test.controller.open()
    const older = Promise.withResolvers<unknown>()
    test.modelCatalog.mockReturnValueOnce(older.promise)
    const stale = test.act({ kind: 'activate', actionId: 'refresh' })
    await test.act({ kind: 'activate', actionId: 'refresh' })
    older.reject(new Error('stale refresh error'))
    await stale
    expect(test.notice.set).not.toHaveBeenCalled()
    test.modelCatalog.mockRejectedValueOnce(new Error('current refresh failed'))
    await test.act({ kind: 'activate', actionId: 'refresh' })
    expect(test.notice.set).toHaveBeenCalledExactlyOnceWith('current refresh failed', 'error')
    test.controller.dispose()
  })

  it.each(['cycle', 'open', 'effort'] as const)('suppresses %s fallback notices when a catalog observer retires the target between awaits', async method => {
    const test = fixture({ catalog: catalog({ groups: [] }), observeCatalog: true })
    test.catalogObserved!.mockImplementation(() => { queueMicrotask(() => test.controller.dispose()) })
    if (method === 'open') await test.controller.open('absent')
    else await test.controller[method]()
    expect(test.notice.set).not.toHaveBeenCalled()
    expect(test.opened).toEqual([])
  })

  it('retains provider filtering on refreshed catalogs and refuses failures from a retired read', async () => {
    const test = fixture({ catalog: catalog({ groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [model('chat')] },
      { id: 'foreign', name: 'Foreign', models: [model('elsewhere')] },
    ] }) })
    await test.controller.open('', 'deepseek')
    expect(test.browser().isCurrent!()).toBe(true)
    await test.act({ kind: 'activate', actionId: 'refresh' })
    expect(test.render()).toContain('DeepSeek/chat')
    expect(test.render()).not.toContain('elsewhere')
    const pending = Promise.withResolvers<unknown>()
    test.modelCatalog.mockReturnValueOnce(pending.promise)
    const refresh = test.act({ kind: 'activate', actionId: 'refresh' })
    test.controller.dispose()
    pending.reject(new Error('retired refresh failure'))
    await refresh
    expect(test.notice.set).not.toHaveBeenCalled()
    expect(test.browser().isCurrent!()).toBe(false)

    const initial = fixture()
    const opening = Promise.withResolvers<unknown>()
    initial.modelCatalog.mockReturnValueOnce(opening.promise)
    const opened = initial.controller.open()
    initial.controller.dispose()
    opening.reject(new Error('retired catalog failure'))
    await opened
    expect(initial.notice.set).not.toHaveBeenCalled()
  })
})

describe('reference Alt+M provider cycle', () => {
  const advertised = catalog({
    groups: [
      { id: 'other', name: 'Other', models: [model('outside')] },
      { id: 'deepseek', name: 'DeepSeek', models: [model('chat'), model('reasoner')] },
    ],
  })

  it.each([
    ['chat', 'reasoner'], ['reasoner', 'chat'], ['unlisted', 'chat'],
  ])('cycles %s to %s in advertised provider order without carrying effort or opening a panel', async (current, next) => {
    const test = fixture({ catalog: advertised, projection: { next: selection('deepseek', current, 'high') } })
    try {
      await test.controller.cycle()
      expect(test.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: test.ref.sessionId, provider: 'deepseek', model: next })
      expect(test.opened).toEqual([])
      expect(test.notice.set).toHaveBeenCalledWith(`Switched to ${next} (deepseek)`, 'success')
    } finally { test.controller.dispose() }
  })

  it('cycles the default before a Session exists, without opening or retaining one', async () => {
    const test = fixture({ current: false, catalog: advertised, defaultSelection: selection('deepseek', 'chat', 'high') })
    try {
      await test.controller.cycle()
      expect(test.defaultModel!.select).toHaveBeenCalledWith(test.client, selection('deepseek', 'reasoner'), expect.any(AbortSignal))
      expect(test.selectModel).not.toHaveBeenCalled()
      expect(test.opened).toEqual([])
    } finally { test.controller.dispose() }
  })

  it('reports the effective provider effort after a confirmed cycle and never writes an unchanged single-model route', async () => {
    const test = fixture({ catalog: advertised, details: detailsOf({ 'deepseek/reasoner': { defaultEffort: 'high' } }) })
    try {
      await test.controller.cycle()
      expect(test.notice.set).toHaveBeenLastCalledWith('Switched to reasoner (deepseek) · thinking high', 'success')
    } finally { test.controller.dispose() }
    const single = fixture()
    try {
      await single.controller.cycle()
      expect(single.selectModel).not.toHaveBeenCalled()
      expect(single.notice.set).toHaveBeenLastCalledWith('Already using chat (deepseek)', 'success')
    } finally { single.controller.dispose() }
  })

  it.each([{ groups: [] }, { groups: [{ id: 'other', name: 'Other', models: [model('outside')] }] }])('reports an empty current-provider catalog without switching providers', async ({ groups }) => {
    const test = fixture({ catalog: catalog({ groups }) })
    try {
      await test.controller.cycle()
      expect(test.notice.set).toHaveBeenCalledWith('the current provider advertises no models', 'warning')
      expect(test.selectModel).not.toHaveBeenCalled()
      expect(test.opened).toEqual([])
    } finally { test.controller.dispose() }
  })

  it('keeps a failed cycle at native warning severity without opening a picker or retrying', async () => {
    const test = fixture({ catalog: advertised })
    test.selectModel.mockRejectedValueOnce(new Error('switch refused'))
    await test.controller.cycle()
    expect(test.notice.set).toHaveBeenLastCalledWith('switch refused', 'warning')
    expect(test.selectModel).toHaveBeenCalledOnce()
    expect(test.opened).toEqual([])
    test.controller.dispose()
  })

  it('discards a catalog response from a retired selection and all keys after unload', async () => {
    const test = fixture({ catalog: advertised })
    const response = deferred<unknown>()
    test.modelCatalog.mockReturnValueOnce(response.promise)
    const cycling = test.controller.cycle()
    test.controller.dispose()
    response.resolve({ ok: true, value: advertised })
    await cycling
    await test.controller.cycle()
    expect(test.selectModel).not.toHaveBeenCalled()
    expect(test.notice.set).not.toHaveBeenCalled()
  })
})
