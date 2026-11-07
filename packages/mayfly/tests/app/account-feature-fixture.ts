/** Real Cordis overlay and feature-operation fixtures; only official Host and local I/O boundaries are doubled. @module */
import { Context } from '@deepseek-ai/cordis'
import { apply } from '@ephemeral-ai/mayfly-ui/provider'
import type { MayflyOverlayEntry, MayflyUiActionEvent, MayflyUiEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/app/features/contracts.ts'
import { RemoteAccountController, type RemoteAccountView } from '../../src/app/features/account.ts'

/** Official account wire view with stable, non-secret fixture destinations. */
export function accountView(phase?: NonNullable<RemoteAccountView['attempt']>['phase'], linked = true, id = 'attempt-1'): RemoteAccountView {
  return {
    status: phase === 'succeeded' ? 'credential-stored' : 'signed-out',
    links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top-up' },
    attempt: phase === undefined ? null : {
      id: id as NonNullable<RemoteAccountView['attempt']>['id'], phase,
      ...linked ? { authorizeUrl: `https://platform.example/sign-in/${id}`, expiresAt: Date.now() + 60_000 } : {},
    },
  }
}

/** Abort-aware external stream, preserving native watch ownership semantics. */
function accountStream() {
  const listeners = new Set<(value: RemoteAccountView) => void>()
  const signals: AbortSignal[] = []
  const watch = vi.fn((signal: AbortSignal) => {
    signals.push(signal)
    return {
      async *[Symbol.asyncIterator]() {
        const queue: RemoteAccountView[] = []
        let wake = (): void => {}
        const changed = (value: RemoteAccountView): void => { queue.push(value); wake() }
        const abort = (): void => { wake() }
        listeners.add(changed)
        signal.addEventListener('abort', abort)
        try {
          while (!signal.aborted) {
            if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
            if (signal.aborted) return
            while (queue.length > 0) yield queue.shift()!
          }
        } finally {
          listeners.delete(changed)
          signal.removeEventListener('abort', abort)
        }
      },
    }
  })
  return { watch, signals, listeners, emit: (view: RemoteAccountView): void => { for (const listener of listeners) listener(view) } }
}

/** One mounted UI provider, real feature controllers, and mutable external Host generation. */
export async function accountFixture() {
  const ctx = new Context()
  const owner = await ctx.plugin({ name: 'account-test-provider', apply })
  const state = { generation: 1 }
  const stateListeners = new Set<() => void>()
  const topologyListeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  const stream = accountStream()
  const account = {
    getState: vi.fn(async () => ({ ok: true as const, value: accountView() })),
    startSignIn: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: accountView('waiting-browser') })),
    cancelSignIn: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: accountView('cancelled') })),
    signOut: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: accountView() })),
    watch: stream.watch,
  }
  const remote = {
    $host: { isLoopback: true }, $on: vi.fn(() => () => {}), account,
    session: {
      modelCatalog: vi.fn(async () => ({ ok: true as const, value: {
        default: { provider: 'deepseek-official', model: 'deepseek-chat' }, routableProviders: ['deepseek-official', 'deepseek-account'], failures: [],
        groups: ['deepseek-official', 'deepseek-account'].map(id => ({ id, name: id, models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })),
      } })),
    },
    llm: {
      listProviders: vi.fn(async () => ({ ok: true as const, value: [] })),
      listConfigurableProviders: vi.fn(async () => ({ ok: true as const, value: [] })),
    },
    credentials: {
      describe: vi.fn(async (refs: readonly string[]) => ({ ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])) })),
      set: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: undefined })),
    },
    settings: {
      describe: vi.fn(async () => ({ ok: true as const, value: {
        writable: true, hasDocument: true,
        namespaces: ['mayfly', 'permission', 'locale'].map(ns => ({ ns, autoGenerate: true, schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 7 })),
      } })),
      mutate: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: {} })),
    },
    permissionPresets: {
      catalog: vi.fn(async () => ({ ok: true as const, value: {
        defaultPreset: 'default',
        defaultOptions: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
        options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
      } })),
    },
  }
  const client = { key: HostKey('account-host'), remote, state: {
    getSnapshot: () => ({ generation: state.generation }),
    subscribe: (listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
  } } as unknown as HostClient
  let attached: readonly HostClient[] = [client]
  let active: HostClient | undefined = client
  const hosts = {
    list: () => attached,
    current: (): RemoteFeatureSelection | undefined => undefined,
    active: () => active,
    subscribe: (listener: () => void) => { topologyListeners.add(listener); return () => { topologyListeners.delete(listener) } },
  }
  const io = {
    callbackOrigin: vi.fn((_client: HostClient): string | undefined => 'http://127.0.0.1:6789'),
    openBrowser: vi.fn(async (_url: string) => true),
    copy: vi.fn(async (_text: string) => {}),
    deliverCallback: vi.fn(async (_url: URL, _signal: AbortSignal) => ({ status: 200 })),
  }
  const snapshot = { locale: 'en', theme: 'dark' }
  const presentation = {
    snapshot,
    themes: [{ key: 'dark', name: 'Mayfly Dark', idea: '', dark: true }, { key: 'tide', name: 'Tide', idea: '', dark: true }],
    setLocale: vi.fn((locale: string) => { snapshot.locale = locale }),
    applyTheme: vi.fn(async (theme: string) => { snapshot.theme = theme }),
    reloadTheme: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}),
  }
  const notice = { set: vi.fn() }
  const context = {
    ctx, hosts, io, notice, presentation,
    t: (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`)),
    subscribeLocale: (listener: () => void) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } },
  } as unknown as RemoteFeatureContext
  const accounts = new RemoteAccountController(context, io, '0.1.4-rc.2')
  const current = (id?: string): MayflyOverlayEntry => {
    const entry = ctx.mayflyOverlays.list().find(entry => id === undefined || entry.id === id)
    if (entry === undefined) throw new Error(`No open overlay ${id ?? ''}`)
    return entry
  }
  let operation = 0
  const eventContext = (entry: MayflyOverlayEntry): MayflyUiEventContext => ({
    surfaceId: entry.id, source: entry.source, revision: entry.revision,
    operationId: `account-operation-${String(++operation)}`, signal: new AbortController().signal, report: vi.fn(),
  })
  const dispatch = async (event: MayflyUiEvent, id?: string) => {
    const entry = current(id)
    const result = await entry.events.prepare(event, eventContext(entry))
    result.publish()
    return result.reply
  }
  const activate = (actionId: string): Promise<unknown> => dispatch({ kind: 'activate', controlId: 'account-actions', actionId, pagePath: [] })
  const dismiss = (): Promise<unknown> => dispatch({ kind: 'dismiss', pagePath: [] } as MayflyUiActionEvent)
  const cleanup = async (): Promise<void> => { accounts.dispose(); await owner.dispose() }
  return {
    ctx, owner, accounts, client, context, remote, account, io, stream, state, stateListeners, topologyListeners, localeListeners,
    presentation, notice, current, dispatch, activate, dismiss, cleanup,
    reconnect: (): void => { state.generation += 1; for (const listener of stateListeners) listener() },
    detach: (): void => { attached = []; active = undefined; for (const listener of topologyListeners) listener() },
    switchHost: (): void => { active = { key: HostKey('other-host') } as HostClient; attached = [client, active]; for (const listener of topologyListeners) listener() },
  }
}
