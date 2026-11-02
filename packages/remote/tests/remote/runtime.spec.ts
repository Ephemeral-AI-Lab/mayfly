import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apps: [] as Array<{
    attach: ReturnType<typeof vi.fn>
    selectOrCreate: ReturnType<typeof vi.fn>
    execute: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    registry: { list: () => unknown[], detach: ReturnType<typeof vi.fn> }
  }>,
  editorActions: undefined as { submit: (text: string) => Promise<void>, onError: (error: unknown) => void, cancel: () => Promise<void>, exit: () => void } | undefined,
  attachError: undefined as Error | undefined,
  coreError: undefined as Error | undefined,
  refreshTranscript: undefined as (() => void) | undefined,
  toolPresentation: undefined as { get: () => undefined } | undefined,
  transcriptSource: undefined as (() => unknown) | undefined,
  transcriptOptions: undefined as {
    readonly t: unknown
    readonly queued: () => unknown
    readonly context: () => unknown
  } | undefined,
  conversationOptions: undefined as {
    onPresentation: () => void
    onCommandResult: (result: { kind: 'success' | 'error', text?: string }) => void
  } | undefined,
  noticeSet: vi.fn(),
  editorDispose: vi.fn(),
  editorFocus: vi.fn(),
  panelDispose: vi.fn(),
  restoreFocus: undefined as (() => void) | undefined,
  bannerFacts: undefined as (() => unknown) | undefined,
  statusFacts: undefined as (() => unknown) | undefined,
  startupStart: vi.fn(),
  startupDispose: vi.fn(),
  startupOptions: undefined as { resume: (sessionId: string) => Promise<void> } | undefined,
  bannerOptions: undefined as { rows: () => number } | undefined,
  defaultModelSelected: undefined as ((client: unknown, selected: unknown) => void) | undefined,
  modelCatalogObserved: undefined as ((client: unknown, catalog: unknown) => void) | undefined,
  setDefaultModel: vi.fn(),
  setModelCatalog: vi.fn(),
  activeClient: { state: { getSnapshot: () => ({ generation: 1 }) } },
}))

vi.mock('../../src/remote/startup.ts', () => ({
  RemoteStartupController: class {
    constructor(_ctx: unknown, _screen: unknown, options: typeof mocks.startupOptions) { mocks.startupOptions = options }
    readonly start = mocks.startupStart
    readonly dispose = mocks.startupDispose
    readonly flyInAt = vi.fn()
    readonly splash = vi.fn()
    readonly handleInput = vi.fn(() => false)
  },
}))

vi.mock('../../src/remote/app.ts', () => ({
  RemoteApp: class {
    readonly registry: { list: () => unknown[], get: (key: unknown) => unknown, detach: ReturnType<typeof vi.fn> }

    constructor() {
      this.registry = {
        list: () => [{ key: 'local' }],
        get: (key: unknown) => key === 'local' ? mocks.activeClient : undefined,
        detach: vi.fn(async () => {}),
      }
      const app = {
        attach: vi.fn(async () => {
          if (mocks.attachError !== undefined) throw mocks.attachError
          return {}
        }),
        selectOrCreate: vi.fn(async () => ({})),
        execute: vi.fn(async (text: string) => ({ exit: text === '/quit' })),
        cancel: vi.fn(async () => {}),
        registry: this.registry,
        activeClient: mocks.activeClient,
        subscribeTopology: vi.fn(() => () => {}),
      }
      mocks.apps.push(app)
      return app
    }
  },
}))

vi.mock('../../src/remote/editor.ts', () => ({
  mountRemoteEditor: vi.fn((_ctx, _screen, _components, _colors, actions) => {
    mocks.editorActions = actions
    return { notice: { set: mocks.noticeSet }, focus: mocks.editorFocus, dispose: mocks.editorDispose, refresh: vi.fn(), retheme: vi.fn() }
  }),
}))

vi.mock('../../src/remote/banner.ts', () => ({
  RemoteBannerComponent: class {
    constructor(_colors: unknown, _components: unknown, facts: () => unknown, options: typeof mocks.bannerOptions) { mocks.bannerFacts = facts; mocks.bannerOptions = options }
  },
}))

vi.mock('../../src/remote/panels.ts', () => ({
  RemotePanelController: class {
    readonly dispose = mocks.panelDispose
    constructor(_screen: unknown, restoreFocus: () => void) { mocks.restoreFocus = restoreFocus }
  },
}))

vi.mock('../../src/remote/status.ts', () => ({
  mountRemoteStatus: vi.fn((_ctx, facts: () => unknown) => {
    mocks.statusFacts = facts
    return { refresh: vi.fn(), dispose: vi.fn(async () => {}) }
  }),
}))

vi.mock('../../src/transcript/remote-model.ts', () => ({
  RemoteConversationModelSource: class {
    readonly attach = vi.fn()
    readonly snapshot = vi.fn()
    readonly presentation = vi.fn(() => ({}))
    readonly sessionFacts = vi.fn(() => ({ values: {} }))
    readonly dispose = vi.fn()
    readonly setDefaultModel = mocks.setDefaultModel
    readonly setModelCatalog = mocks.setModelCatalog

    constructor(_tools: { get: () => undefined }, refresh: () => void, options: {
      onPresentation: () => void
      onCommandResult: (result: { kind: 'success' | 'error', text?: string }) => void
    }) {
      mocks.toolPresentation = _tools
      mocks.refreshTranscript = refresh
      mocks.conversationOptions = options
    }
  },
}))

vi.mock('../../src/remote/side-views.ts', () => ({
  RemoteSideViews: class {
    readonly present = vi.fn()
    readonly close = vi.fn()
    readonly dispose = vi.fn()
    readonly presentation = vi.fn()
    readonly selected = vi.fn()
    readonly current = vi.fn()
    readonly references = vi.fn(() => [])
    readonly sessionFacts = vi.fn()
    kind() { return undefined }
    readonly navigation = vi.fn()
    readonly subscribe = vi.fn(() => () => {})
  },
}))

vi.mock('../../src/remote/features/sessions.ts', () => ({
  RemoteSessionsBrowserController: class {
    readonly open = vi.fn()
    readonly dispose = vi.fn()
  },
}))

vi.mock('../../src/remote/interactions/plain-panels.ts', () => ({
  RemotePlainPanels: class {},
}))

vi.mock('../../src/remote/features.ts', () => ({
  mountRemoteFeatures: vi.fn(() => ({ context: {}, commands: [], dispose: mocks.panelDispose })),
}))

vi.mock('../../src/remote/features/commands.ts', () => ({
  mergeRemoteFeatureCommandSources: vi.fn(() => []),
}))

vi.mock('../../src/remote/configuration-composition.ts', () => ({
  mountRemoteConfigurationComposition: vi.fn((_base: unknown, options: { onDefaultModelSelected: typeof mocks.defaultModelSelected, onModelCatalogObserved: typeof mocks.modelCatalogObserved }) => {
    mocks.defaultModelSelected = options.onDefaultModelSelected
    mocks.modelCatalogObserved = options.onModelCatalogObserved
    return { commands: [], dispose: mocks.panelDispose }
  }),
  remoteClientVersion: vi.fn(() => '0.1.4-rc.2'),
}))

vi.mock('../../src/remote/operations-composition.ts', () => ({
  mountRemoteOperationsComposition: vi.fn(() => ({ commands: [], dispose: mocks.panelDispose })),
}))

vi.mock('../../src/remote/editor-composition.ts', () => ({
  mountEditorComposition: vi.fn(() => ({
    controller: {
      copyText: vi.fn(async () => 'native'),
      openText: vi.fn(async () => {}),
      readAttachment: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => false),
      requeue: vi.fn(),
      restoreQueued: vi.fn(),
    },
    dispose: mocks.panelDispose,
  })),
}))

vi.mock('../../src/remote/host-composition.ts', () => ({
  attachMayflyHostClient: vi.fn(),
  resolveMayflyToolPresentation: vi.fn(() => ({
    presentationRevision: 'test:test:test',
    present: vi.fn(),
  })),
}))

vi.mock('@ephemeral-ai/mayfly/transcript', () => ({
  ACTION_TOGGLE_COLLAPSE: 'mayfly.transcript.toggle-collapse',
  TRANSCRIPT_LOCALE: {}, mountTranscriptLocale: vi.fn(),
  transcriptTranslator: () => (text: string) => text,
  observeTranscriptLocale: () => vi.fn(), TranscriptPresentationPolicy: class {}, followPresentationSettings: vi.fn(),
  TranscriptController: class {
    readonly setView = vi.fn((_name: string, source: () => unknown) => { mocks.transcriptSource = source })
    readonly show = vi.fn()
    readonly attach = vi.fn()
    readonly refresh = vi.fn()
    readonly dispose = vi.fn()

    constructor(options: { readonly t: unknown, readonly queued: () => unknown, readonly context: () => unknown }) {
      mocks.transcriptOptions = options
    }
  },
}))

vi.mock('@ephemeral-ai/mayfly/core', () => ({
  name: 'core',
  Config: undefined,
  inject: [],
  apply: (ctx: any) => {
    if (mocks.coreError !== undefined) throw mocks.coreError
    ctx.provide('mayflyScreen', {
      rows: 30,
      editorRowsFromBottom: 4,
      mountDockSlot: vi.fn(() => ({ dispose: vi.fn(), focus: vi.fn() })),
      mountContentSlot: vi.fn(() => ({ dispose: vi.fn() })),
      requestRender: vi.fn(),
    })
    ctx.provide('mayflyComponents', {})
    ctx.provide('mayflyKeymap', { register: vi.fn(() => vi.fn()) })
    ctx.provide('mayflyTheme', { colors: {} })
    ctx.provide('mayflyUiImages', { provide: vi.fn(() => vi.fn()) })
  },
}))
vi.mock('@ephemeral-ai/mayfly/frontend', () => ({
  name: 'frontend', apply: () => {}, Config: undefined, inject: [],
  interpolateLocaleMessage: (key: string) => key,
}))
vi.mock('@ephemeral-ai/mayfly/theme-dark', () => ({ name: 'theme-dark', apply: () => {}, Config: undefined, inject: [] }))
vi.mock('@ephemeral-ai/mayfly-ui/provider', () => ({ name: 'ui-provider', apply: () => {}, Config: undefined, inject: [] }))

import { runRemoteFrontend } from '../../src/remote/runtime.ts'

const startupUrl = 'http://127.0.0.1:3080/?token=secret'

describe('runRemoteFrontend', () => {
  it('starts sessionless, attaches, and tears down through the editor exit action', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    const running = runRemoteFrontend({ startupUrl })
    await vi.waitFor(() => { expect(mocks.editorActions).toBeDefined() })
    mocks.editorActions!.exit()
    await running
    expect(mocks.apps[0]!.attach).toHaveBeenCalledWith(startupUrl, undefined)
    expect(mocks.apps[0]!.selectOrCreate).not.toHaveBeenCalled()
    expect(mocks.apps[0]!.registry.detach).toHaveBeenCalledWith('local')
    expect(mocks.startupStart).toHaveBeenCalled()
    expect(mocks.startupDispose).toHaveBeenCalled()
  })

  it('uses the prompt viewport for startup and applies only active confirmed default selections', async () => {
    mocks.editorActions = undefined
    mocks.setDefaultModel.mockClear()
    const running = runRemoteFrontend({ startupUrl })
    await vi.waitFor(() => { expect(mocks.editorActions).toBeDefined() })
    expect(mocks.bannerOptions!.rows()).toBe(26)
    const selected = { provider: 'deepseek', model: 'pro' }
    mocks.defaultModelSelected!({}, selected)
    expect(mocks.setDefaultModel).not.toHaveBeenCalled()
    mocks.defaultModelSelected!(mocks.activeClient, selected)
    expect(mocks.setDefaultModel).toHaveBeenCalledExactlyOnceWith(selected)
    mocks.setModelCatalog.mockClear()
    const client = Object.assign(mocks.activeClient, { key: 'local' })
    const catalog = { groups: [], default: selected }
    mocks.modelCatalogObserved!({}, catalog)
    expect(mocks.setModelCatalog).not.toHaveBeenCalled()
    mocks.modelCatalogObserved!(client, catalog)
    expect(mocks.setModelCatalog).toHaveBeenCalledExactlyOnceWith('local', catalog)
    mocks.editorActions!.exit()
    await running
    mocks.defaultModelSelected!(mocks.activeClient, selected)
    expect(mocks.setDefaultModel).toHaveBeenCalledOnce()
    mocks.modelCatalogObserved!(client, catalog)
    expect(mocks.setModelCatalog).toHaveBeenCalledOnce()
  })

  it('invokes editor and transcript callbacks without depending on a real TTY', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    mocks.transcriptSource = undefined
    const running = runRemoteFrontend({ startupUrl })
    await vi.waitFor(() => { expect(mocks.editorActions).toBeDefined() })
    mocks.transcriptSource!()
    mocks.toolPresentation!.get()
    mocks.refreshTranscript!()
    await mocks.editorActions!.submit('hello')
    expect(mocks.apps[0]!.execute).toHaveBeenCalledWith('hello')
    await mocks.editorActions!.onError(new Error('offline'))
    await mocks.editorActions!.onError('disconnect')
    expect(mocks.noticeSet).toHaveBeenCalledWith('offline')
    expect(mocks.noticeSet).toHaveBeenCalledWith('disconnect')
    mocks.conversationOptions!.onPresentation()
    mocks.conversationOptions!.onCommandResult({ kind: 'success' })
    mocks.conversationOptions!.onCommandResult({ kind: 'error', text: 'command failed' })
    expect(mocks.noticeSet).toHaveBeenCalledWith('command failed')
    expect(mocks.bannerFacts!()).toEqual({})
    expect(mocks.statusFacts!()).toEqual({ presentation: {}, values: {} })
    expect(mocks.transcriptOptions).toBeDefined()
    expect(mocks.transcriptOptions!.t).toBeDefined()
    mocks.transcriptOptions!.queued()
    mocks.transcriptOptions!.context()
    mocks.restoreFocus!()
    expect(mocks.editorFocus).toHaveBeenCalled()
    await mocks.editorActions!.submit('/quit')
    await running
    await mocks.editorActions!.cancel()
    expect(mocks.apps[0]!.cancel).toHaveBeenCalledOnce()
    mocks.editorActions!.exit()
    await running
    expect(mocks.editorDispose).toHaveBeenCalled()
    expect(mocks.panelDispose).toHaveBeenCalled()
  })

  it('stops through SIGINT and SIGTERM', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      mocks.apps.length = 0
      mocks.editorActions = undefined
      const running = runRemoteFrontend({ startupUrl })
      await vi.waitFor(() => { expect(mocks.editorActions).toBeDefined() })
      process.emit(signal)
      await running
      expect(mocks.apps[0]!.registry.detach).toHaveBeenCalledWith('local')
    }
  })

  it('honors a startup task that requests exit', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    await runRemoteFrontend({ startupUrl, hostId: 'local', task: '/quit' })
    expect(mocks.apps[0]!.attach).toHaveBeenCalledWith(startupUrl, 'local')
    expect(mocks.apps[0]!.execute).toHaveBeenCalledWith('/quit')
    expect(mocks.apps[0]!.registry.detach).toHaveBeenCalledWith('local')
  })

  it('cleans up local resources when initial attach fails', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    mocks.attachError = new Error('offline')
    await expect(runRemoteFrontend({ startupUrl })).rejects.toThrow('offline')
    expect(mocks.apps[0]!.registry.detach).toHaveBeenCalledWith('local')
    mocks.attachError = undefined
  })

  it('waits for exit after an empty startup task and stops only once', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    const running = runRemoteFrontend({ startupUrl, task: ' ' })
    await vi.waitFor(() => { expect(mocks.editorActions).toBeDefined() })
    expect(mocks.apps[0]!.execute).not.toHaveBeenCalled()
    mocks.editorActions!.exit()
    process.emit('SIGINT')
    process.emit('SIGTERM')
    await running
    expect(mocks.apps[0]!.registry.detach).toHaveBeenCalledOnce()
  })

  it('cleans up when UI plugin initialization fails', async () => {
    mocks.apps.length = 0
    mocks.editorActions = undefined
    mocks.coreError = new Error('renderer failed')
    try {
      await expect(runRemoteFrontend({ startupUrl })).rejects.toThrow('renderer failed')
    } finally {
      mocks.coreError = undefined
    }
    expect(mocks.apps).toEqual([])
  })
})
