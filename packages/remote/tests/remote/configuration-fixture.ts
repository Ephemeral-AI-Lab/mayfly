/** Focused native DTO and shared-browser fixture for configuration surfaces.
 * @module @ephemeral-ai/mayfly-remote/tests/configuration-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { interpolateLocaleMessage, MayflyLocaleService } from '@ephemeral-ai/mayfly/frontend'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { vi, type Mock } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features/contracts.ts'
import type { RemoteBrowserOptions, RemoteBrowserPanel } from '../../src/remote/panels/browser.ts'
import { REMOTE_THEMES } from '../../src/remote/features/presentation.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

export function schemaJson(schema: Schema): SettingsNamespaceView['schema'] {
  return JSON.parse(JSON.stringify(schema)) as SettingsNamespaceView['schema']
}

export function namespace(ns = 'mayfly', options: Partial<SettingsNamespaceView> = {}): SettingsNamespaceView {
  return { ns, revision: 7, autoGenerate: true, applies: 'live', schema: schemaJson(Schema.object({ theme: Schema.string().default('dark') })), value: { theme: 'dark' }, secrets: [], ...options }
}

export function permissionCatalog() {
  const options = [
    { value: 'safe', name: 'Safe', description: 'Read only' },
    { value: 'review', name: 'Review', description: 'Ask' },
    { value: 'unrestricted', name: 'Full access', description: 'No sandbox' },
  ]
  return { options, defaultOptions: options, defaultPreset: 'safe' }
}

export function configurationFixture(open: Mock, options: { readonly session?: boolean, readonly namespaces?: readonly SettingsNamespaceView[] } = {}) {
  const cleanups = new Set<() => void>()
  const locale = new MayflyLocaleService(new Context(), { systemLocale: 'en' })
  const presentationListeners = new Set<() => void>()
  const topology = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const projectionListeners = new Set<() => void>()
  const events = new Map<string, Set<(...args: unknown[]) => void>>()
  let projection: unknown = { currentValue: 'safe' }
  const state = { generation: 1, status: 'connected' }
  let settings: SettingsDescribeValue = { writable: true, hasDocument: true, namespaces: [...options.namespaces ?? [namespace()]] }
  const describe = vi.fn(async (): Promise<unknown> => ({ ok: true, value: settings }))
  const mutate = vi.fn(async (ns: string, _ops?: readonly unknown[], _revision?: number): Promise<unknown> => ({ ok: true, value: { ...settings.namespaces.find(candidate => candidate.ns === ns), revision: 8 } }))
  const update = vi.fn(async (): Promise<unknown> => ({ ok: true, value: namespace() }))
  const replace = vi.fn(async (): Promise<unknown> => ({ ok: true, value: namespace() }))
  const catalog = vi.fn(async (): Promise<unknown> => ({ ok: true, value: permissionCatalog() }))
  const presets = vi.fn(async (): Promise<unknown> => ({ ok: true, value: { presets: [] } }))
  const command = vi.fn(async (_line: string): Promise<unknown> => ({ ok: true, value: { matched: true } }))
  const face = {
    getSnapshot: () => projection,
    subscribe: vi.fn((listener: () => void) => { projectionListeners.add(listener); return () => { projectionListeners.delete(listener) } }),
  }
  const client = {
    key: HostKey('host-a'),
    state: {
      getSnapshot: () => ({ ...state }),
      subscribe: (listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    },
    remote: {
      settings: { describe, mutate, update, replace }, permissionPresets: { catalog }, agentPresets: { list: presets },
      $on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        let listeners = events.get(event)
        if (listeners === undefined) { listeners = new Set(); events.set(event, listeners) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }),
    },
  } as unknown as HostClient
  const selection = { client, ref: { host: client.key, sessionId: SessionId('same-id') }, binding: { session: { projections: { faceOf: () => face }, command } } } as unknown as RemoteFeatureSelection
  let clients: readonly HostClient[] = [client]
  let selected: RemoteFeatureSelection | undefined = options.session === false ? undefined : selection
  let active: HostClient | undefined = client
  const current = vi.fn(() => selected)
  const hosts = {
    list: vi.fn(() => clients), current, active: () => active,
    subscribe: vi.fn((listener: () => void) => { topology.add(listener); return () => { topology.delete(listener) } }),
  }
  const snapshot = { theme: 'dark', locale: 'en' }
  const presentation = {
    snapshot, themes: REMOTE_THEMES,
    applyTheme: vi.fn(async (theme: string) => { snapshot.theme = theme; for (const listener of presentationListeners) listener() }),
    applyCustomTheme: vi.fn(async (_path: string, _base = 'dark') => { snapshot.theme = 'custom'; for (const listener of presentationListeners) listener() }),
    reloadTheme: vi.fn(async () => {}),
    setLocale: vi.fn((language: string) => { snapshot.locale = language; locale.setPreference(language as 'en' | 'zh') }),
    subscribe: vi.fn((listener: () => void) => { presentationListeners.add(listener); return () => { presentationListeners.delete(listener) } }),
  }
  const interactionState = { settingsSource: () => undefined as unknown, currentThemeKey: 'dark' }
  const keymap = { setPreferPlain: vi.fn(), applyOverrides: vi.fn() }
  const emitTab = vi.fn()
  const registryListeners = new Set<(delta: unknown) => void>()
  const ctx = {
    inject: vi.fn((_names: readonly string[], callback: (ctx: unknown) => void) => { callback(ctx); return { dispose: async () => {} } }),
    effect: vi.fn((effect: () => (() => void)) => {
      const cleanup = effect()
      const release = () => { if (!cleanups.delete(release)) return; cleanup() }
      cleanups.add(release)
      return release
    }),
    get: vi.fn((name: string) => name === 'mayflyLocale' ? locale : name === 'mayflyInteractionState' ? interactionState : name === 'mayflyKeymap' ? keymap : name === 'mayflyUiInteraction' ? { get: () => ({ emit: emitTab }) } : undefined),
    mayflyLocale: locale,
    mayflyOverlays: { focus: vi.fn(() => false), subscribe: vi.fn((listener: (delta: unknown) => void) => { registryListeners.add(listener); return () => { registryListeners.delete(listener) } }) },
    emit: vi.fn(),
  }
  const context = {
    ctx, hosts, presentation, t: interpolateLocaleMessage, notice: { set: vi.fn() },
    subscribeLocale: (listener: () => void) => locale.subscribe(listener),
  } as unknown as RemoteFeatureContext
  const opened: { readonly options: RemoteBrowserOptions, readonly panel: RemoteBrowserPanel, readonly refresh: Mock, readonly close: Mock }[] = []
  open.mockImplementation((_context: unknown, options: RemoteBrowserOptions) => {
    let closed = false
    const close = vi.fn(() => { if (closed) return; closed = true; options.signal?.removeEventListener('abort', close); options.onClosed?.() })
    const refresh = vi.fn()
    const panel = { get closed() { return closed }, close, refresh }
    options.signal?.addEventListener('abort', close, { once: true })
    opened.push({ options, panel, close, refresh })
    return panel
  })
  const browser = (index = opened.length - 1) => opened[index]!.options
  const act = async (event: Record<string, unknown>, signal = new AbortController().signal, index = opened.length - 1) => await browser(index).action!(event as unknown as MayflyUiActionEvent, { signal, source: browser(index).source?.() ?? [], operationId: 'test-action', report: vi.fn() } as unknown as MayflyUiEventContext)
  const observe = (event: Record<string, unknown>, index = opened.length - 1) => browser(index).observe?.(event as unknown as MayflyUiObservationEvent)
  const emit = (event: string, ...args: unknown[]) => { for (const listener of events.get(event) ?? []) listener(...args) }
  const dispose = () => { for (const item of opened) item.close(); for (const cleanup of cleanups) cleanup(); locale.dispose() }
  return {
    context, ctx, client, hosts, selection, current, describe, mutate, update, replace, catalog, presets, command, face, projectionListeners, events,
    state, stateListeners, topology, locale, registryListeners,
    ack: (id: string, operationId = 'test-action') => { for (const listener of registryListeners) listener({ kind: 'upsert', entry: { id, update: { reason: 'ack', operationId } } }) }, presentation, interactionState, keymap, emitTab, presentationListeners,
    notice: context.notice as { set: Mock }, opened, browser, act, observe, emit, dispose,
    render: (index = opened.length - 1) => JSON.stringify(browser(index).view()),
    setSettings: (next: SettingsDescribeValue) => { settings = next },
    project: (next: unknown) => { projection = next; for (const listener of projectionListeners) listener() },
    detach: () => { clients = []; selected = undefined; active = undefined; for (const listener of topology) listener() },
    select: (next: RemoteFeatureSelection | undefined) => { selected = next; for (const listener of topology) listener() },
    reconnect: () => { state.generation += 1; for (const listener of stateListeners) listener() },
    active: (next: HostClient) => { active = next; clients = [...clients, next]; for (const listener of topology) listener() },
  }
}
