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
import type { RemoteFeaturePanel } from '../../src/remote/features/panel.ts'

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
  readonly catalog?: ModelCatalog
  readonly details?: RemoteModelCatalogDetails
  readonly current?: boolean
  readonly attached?: boolean
  readonly projection?: unknown
  readonly defaultSelection?: ModelSelection
  readonly withDefaultModel?: boolean
  readonly withSource?: boolean
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
  const current = vi.fn(() => (options.current === false ? undefined : { ref, client, binding }))
  const hosts = {
    current,
    list: vi.fn(() => (attached ? [client] : [])),
    subscribe: vi.fn(() => () => {}),
  }
  const open = vi.fn()
  const overlays = { open, close: vi.fn() }
  const notice = { set: vi.fn() }
  const context = {
    ctx: {},
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
  const opened: { component: RemoteFeaturePanel, lease: { close: ReturnType<typeof vi.fn>, closed: boolean } }[] = []
  open.mockImplementation((component: RemoteFeaturePanel) => {
    const lease = { closed: false, close: vi.fn() }
    opened.push({ component, lease })
    return lease
  })
  const controller = new RemoteModelsController(context, source, defaultModel)
  const panel = (index = 0): RemoteFeaturePanel => opened[index]!.component
  const render = (index = 0, width = 120): string => panel(index).render(width).join('\n')
  return {
    context, controller, client, ref, binding, projection, faceOf, listeners,
    modelCatalog, selectModel, hosts, current, notice, source, defaultModel,
    overlays, opened, panel, render,
  }
}

describe('remoteModelRows', () => {
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

describe('RemoteModelsController roster', () => {
  it('opens the Session picker with merged details and marks the current route', async () => {
    const { controller, overlays, opened, render, modelCatalog, source, faceOf } = fixture({
      details: detailsOf({
        'deepseek/chat': { contextWindow: 131072, efforts: ['low', 'high'], defaultEffort: 'low' },
      }),
    })
    await controller.open()

    expect(opened).toHaveLength(1)
    expect(overlays.open).toHaveBeenCalledOnce()
    expect(modelCatalog).toHaveBeenCalledOnce()
    expect(source).toBeDefined()
    expect(faceOf).toHaveBeenCalledWith('modelSelection')
    const text = render()
    expect(text).toContain('Select a model')
    expect(text).toContain('> DeepSeek/DeepSeek Chat')
    expect(text).toContain('128k context · Thinking: low')
  })

  it('renders rows with missing provider/model metadata without inventing values', async () => {
    const { controller, render } = fixture({
      catalog: catalog({
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [model('bare')] },
          { id: 'other', name: 'Other', models: [model('chat', { name: 'Other Chat' })] },
        ],
      }),
      projection: { next: { provider: 'other', model: 'chat' } },
    })
    await controller.open()

    const text = render()
    // One line per row: the bare row has no detail line carrying invented metadata.
    expect(text.split('\n').filter(line => line.includes('DeepSeek/bare') || line.includes('Other/Other Chat'))).toHaveLength(2)
    expect(text).not.toContain('Thinking')
    expect(text).not.toContain('context')
    // The current route is also the initially focused row, so it carries the cursor.
    expect(text).toContain('> Other/Other Chat')
  })

  it('reports a catalog failure as a notice and opens no panel', async () => {
    const { controller, modelCatalog, notice, opened } = fixture()
    modelCatalog.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'host offline' } })
    await controller.open()

    expect(notice.set).toHaveBeenCalledWith('host offline')
    expect(opened).toEqual([])
  })

  it('paints catalog failures in the panel footer', async () => {
    const { controller, render } = fixture({
      catalog: catalog({ failures: [{ id: 'broken', name: 'Broken provider', message: 'timed out' }] }),
    })
    await controller.open()
    expect(render()).toContain('Broken provider: timed out')
  })
})

describe('RemoteModelsController Session commit', () => {
  it('selects the focused route with the chosen reasoning effort and closes the panel', async () => {
    const { controller, panel, opened, selectModel, notice, ref } = fixture({
      details: detailsOf({ 'deepseek/chat': { efforts: ['high', 'low'], defaultEffort: 'high' } }),
    })
    await controller.open()

    // No pin yet: the first right press names the first merged effort.
    panel().handleInput('\x1b[C')
    panel().handleInput('\r')
    await vi.waitFor(() => { expect(selectModel).toHaveBeenCalledOnce() })

    expect(selectModel.mock.calls[0]![0]).toEqual({
      sessionId: ref.sessionId,
      provider: 'deepseek',
      model: 'chat',
      reasoningEffort: 'high',
    })
    await vi.waitFor(() => { expect(notice.set).toHaveBeenCalledWith('Switched to chat (deepseek)') })
    expect(opened[0]!.lease.close).toHaveBeenCalledOnce()
  })

  it('omits the reasoningEffort key entirely when no effort is pinned', async () => {
    const { controller, panel, opened, selectModel, ref } = fixture()
    await controller.open()

    panel().handleInput('\r')
    await vi.waitFor(() => { expect(selectModel).toHaveBeenCalledOnce() })
    const request = selectModel.mock.calls[0]![0]
    expect(request).toEqual({ sessionId: ref.sessionId, provider: 'deepseek', model: 'chat' })
    expect(Object.hasOwn(request, 'reasoningEffort')).toBe(false)
    await vi.waitFor(() => { expect(opened[0]!.lease.close).toHaveBeenCalledOnce() })
  })

  it('reports a Host commit failure as a notice and leaves the panel open', async () => {
    const { controller, panel, opened, selectModel, notice } = fixture()
    selectModel.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'host offline' } })
    await controller.open()

    panel().handleInput('\r')
    await vi.waitFor(() => { expect(notice.set).toHaveBeenCalledWith('host offline') })
    expect(opened[0]!.lease.close).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
  })
})

describe('RemoteModelsController default-model route', () => {
  it('uses the default-model DTO adapter when no Session is selected', async () => {
    const { controller, panel, selectModel, defaultModel, ref, client } = fixture({
      current: false,
      withDefaultModel: true,
    })
    await controller.open()

    expect(defaultModel!.read).toHaveBeenCalledOnce()
    panel().handleInput('\r')
    await vi.waitFor(() => { expect(defaultModel!.select).toHaveBeenCalledOnce() })
    expect(selectModel).not.toHaveBeenCalled()
    const [selectedClient, next, signal] = defaultModel!.select.mock.calls[0] as unknown as [HostClient, ModelSelection, AbortSignal]
    expect(selectedClient).toBe(client)
    expect(next).toEqual({ provider: 'deepseek', model: 'chat' })
    expect(Object.hasOwn(next, 'reasoningEffort')).toBe(false)
    expect(signal).toBeInstanceOf(AbortSignal)
    // The Session route is not borrowed for a Session-independent write.
    expect(ref.sessionId).toBeTruthy()
  })

  it('uses the Session adapter, never the default-model adapter, when a Session is selected', async () => {
    const { controller, panel, selectModel, defaultModel, ref } = fixture({ withDefaultModel: true })
    await controller.open()
    panel().handleInput('\r')
    await vi.waitFor(() => { expect(selectModel).toHaveBeenCalledOnce() })

    expect(defaultModel!.select).not.toHaveBeenCalled()
    expect(selectModel.mock.calls[0]![0]).toMatchObject({ sessionId: ref.sessionId })
  })

  it('refuses the default picker when the Host has no defaultModel capability', async () => {
    const { controller, notice, opened, modelCatalog } = fixture({ current: false, withDefaultModel: false })
    await controller.open()

    expect(notice.set).toHaveBeenCalledWith('Selecting the default model requires the Host defaultModel capability.')
    expect(opened).toEqual([])
    expect(modelCatalog).not.toHaveBeenCalled()
  })
})

describe('RemoteModelsController thinking control', () => {
  it('cycles the effort for the focused row, pins it, and clears it on delete', async () => {
    const { controller, panel, render, selectModel } = fixture({
      catalog: catalog({
        groups: [{
          id: 'deepseek',
          name: 'DeepSeek',
          models: [
            model('chat', { reasoning: { efforts: [{ id: 'own', name: 'Own' }], defaultEffort: 'own' } }),
            model('flex'),
          ],
        }],
      }),
      details: detailsOf({
        'deepseek/chat': { efforts: ['high', 'low'], defaultEffort: 'low' },
        'deepseek/flex': { efforts: ['fast'] },
      }),
    })
    await controller.open()

    expect(render()).toContain('Thinking: low')
    panel().handleInput('\x1b[C')
    expect(render()).toContain('Thinking: high')
    // Cycling back past the first named effort lands on "no pin", shown as the default.
    panel().handleInput('\x1b[D')
    expect(render()).toContain('Thinking: Provider default')
    panel().handleInput('\x1b[C')
    panel().handleInput('\x1b[C')
    expect(render()).toContain('Thinking: low')
    // Delete clears the pin, so the row's own default is what remains visible.
    panel().handleInput('\x18')
    expect(render()).toContain('Thinking: low')

    // A row whose only effort has no default shows the provider default until pinned.
    panel().handleInput('\x1b[B')
    expect(render()).toContain('Thinking: Provider default')
    panel().handleInput('\x1b[C')
    expect(render()).toContain('Thinking: fast')
    panel().handleInput('\x18')
    expect(render()).toContain('Thinking: Provider default')

    // Delete stayed cleared for the chat row, so its commit carries no reasoningEffort.
    panel().handleInput('\x1b[A')
    panel().handleInput('\r')
    await vi.waitFor(() => { expect(selectModel).toHaveBeenCalledOnce() })
    expect(Object.hasOwn(selectModel.mock.calls[0]![0], 'reasoningEffort')).toBe(false)
  })
})

describe('RemoteModelsController stale results', () => {
  it('does not publish a roster whose Session was replaced during the catalog read', async () => {
    const { controller, modelCatalog, current, opened, notice } = fixture()
    const pending = deferred<unknown>()
    modelCatalog.mockReturnValueOnce(pending.promise as never)

    const opening = controller.open()
    expect(modelCatalog).toHaveBeenCalledOnce()
    current.mockReturnValue(undefined)
    pending.resolve({ ok: true, value: catalog() })
    await opening

    expect(opened).toEqual([])
    expect(notice.set).not.toHaveBeenCalled()
  })

  it('keeps the newest refresh roster when an older read settles last', async () => {
    const { controller, panel, modelCatalog, render } = fixture()
    await controller.open()
    expect(render()).toContain('DeepSeek/DeepSeek Chat')

    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    modelCatalog.mockReturnValueOnce(older.promise as never).mockReturnValueOnce(newer.promise as never)
    panel().handleInput('\x12')
    panel().handleInput('\x12')

    newer.resolve({ ok: true, value: catalog({ groups: [{ id: 'b', name: 'B', models: [model('b-model')] }] }) })
    await vi.waitFor(() => { expect(render()).toContain('B/b-model') })

    older.resolve({ ok: true, value: catalog({ groups: [{ id: 'c', name: 'C', models: [model('c-model')] }] }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(render()).toContain('B/b-model')
    expect(render()).not.toContain('C/c-model')
  })

  it('reports a refresh failure as a notice without closing the panel', async () => {
    const { controller, panel, modelCatalog, notice, opened, render } = fixture()
    await controller.open()
    modelCatalog.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'catalog read failed' } })
    panel().handleInput('\x12')

    await vi.waitFor(() => { expect(notice.set).toHaveBeenCalledWith('catalog read failed') })
    expect(opened[0]!.lease.close).not.toHaveBeenCalled()
    expect(render()).toContain('DeepSeek/DeepSeek Chat')
  })

  it('re-marks the current route when the model projection changes', async () => {
    const { controller, projection, listeners, render } = fixture({
      catalog: catalog({
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [model('chat'), model('reasoner')] }],
      }),
    })
    await controller.open()
    expect(render()).toContain('> DeepSeek/chat')

    projection.getSnapshot.mockReturnValue({ next: { provider: 'deepseek', model: 'reasoner' } })
    for (const listener of listeners) listener()
    expect(render()).toContain('* DeepSeek/reasoner')
    // Focus stays where the operator left it; only the current marker moves.
    expect(render()).toContain('> DeepSeek/chat')
    expect(render()).not.toContain('* DeepSeek/chat')
  })
})
