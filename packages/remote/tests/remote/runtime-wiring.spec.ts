/** Actual Cordis lifetime with controlled subsystem boundaries for standalone runtime wiring. @module */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranscriptControllerOptions } from '@ephemeral-ai/mayfly/transcript'
import type { MayflyKeyAction } from '@ephemeral-ai/mayfly/core'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import type { RemoteSideSelection, RemoteSideViewOptions } from '../../src/remote/side-views.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'
import type { RemoteOperationsCompositionOptions } from '../../src/remote/operations-composition.ts'
import type { RemoteFeatureContext } from '../../src/remote/features.ts'
import type { RemoteSessionFactsSnapshot } from '../../src/frontend/session-facts.ts'

type StartupOptions = ConstructorParameters<typeof import('../../src/remote/startup.ts').RemoteStartupController>[2]
type EditorOptions = Parameters<typeof import('../../src/remote/editor-composition.ts').mountEditorComposition>[0]
type FeatureOptions = Parameters<typeof import('../../src/remote/features.ts').mountRemoteFeatures>[0]
type BannerOptions = ConstructorParameters<typeof import('../../src/remote/banner.ts').RemoteBannerComponent>[3]
type EditorState = NonNullable<Parameters<typeof import('../../src/remote/editor.ts').mountRemoteEditor>[5]>
type SessionsOptions = ConstructorParameters<typeof import('../../src/remote/features/sessions.ts').RemoteSessionsBrowserController>[1]
type ContextOptions = ConstructorParameters<typeof import('../../src/transcript/context-source.ts').RemoteTranscriptContextSource>[0]

const wiring = vi.hoisted(() => ({
  ctx: undefined as Context | undefined,
  keyActions: [] as MayflyKeyAction[],
  localeChanged: undefined as (() => void) | undefined,
  policyChanged: undefined as (() => void) | undefined,
  locale: 'en', offLocale: vi.fn(), refreshLocale: vi.fn(), refreshPresentationPolicy: vi.fn(), toggleRecent: vi.fn(), jumpNew: vi.fn(),
  execute: vi.fn(async (_text: string): Promise<{ exit: boolean }> => ({ exit: false })),
  image: undefined as ((id: string) => Promise<unknown>) | undefined,
  toolResolver: undefined as ((ref: SessionRef) => unknown) | undefined,
  statusOptions: undefined as Parameters<typeof import('../../src/remote/status.ts').mountRemoteStatus>[2] | undefined,
  actions: undefined as Parameters<typeof import('../../src/remote/editor.ts').mountRemoteEditor>[4] | undefined,
  editorState: undefined as EditorState | undefined,
  banner: undefined as BannerOptions | undefined,
  transcript: undefined as TranscriptControllerOptions | undefined,
  sideOptions: undefined as RemoteSideViewOptions | undefined,
  startupOptions: undefined as StartupOptions | undefined,
  features: undefined as FeatureOptions | undefined,
  operations: undefined as RemoteOperationsCompositionOptions | undefined,
  editorOptions: undefined as EditorOptions | undefined,
  sessions: undefined as SessionsOptions | undefined,
  contextOptions: undefined as ContextOptions | undefined,
  contextSnapshot: undefined as ReturnType<NonNullable<TranscriptControllerOptions['context']>>,
  contextDispose: vi.fn(), disposeSide: vi.fn(), disposeConversation: vi.fn(),
  primaryFacts: { values: {} } as RemoteSessionFactsSnapshot,
  appArgs: [] as unknown[],
  initialCommands: undefined as unknown,
  topologies: new Set<() => void>(),
  sideListeners: new Set<() => void>(),
  ref: undefined as SessionRef | undefined,
  binding: undefined as RemoteSideSelection['binding'] | undefined,
  side: undefined as RemoteSideSelection | undefined,
  sideFacts: undefined as RemotePresentationFacts | undefined,
  sideStatus: undefined as { values: Record<string, unknown> } | undefined,
  navigation: undefined as { counterpart: 'primary' | 'btw' | 'subagent', close: 'subagent' | 'btw' } | undefined,
  currentSide: undefined as SessionRef | undefined,
  back: false,
  closeTarget: undefined as SessionRef | undefined,
  references: [] as SessionRef[],
  client: undefined as HostClient | undefined,
  generation: 1,
  defaultFacts: { queue: [], contextWindow: 100, contextTokens: 10 } as unknown as RemotePresentationFacts,
  primaryImage: undefined as ReturnType<typeof import('../../src/transcript/remote-model.ts').RemoteConversationModelSource.prototype.imageAttachment>,
  sideImage: undefined as ReturnType<typeof import('../../src/transcript/remote-model.ts').RemoteConversationModelSource.prototype.imageAttachment>,
  controller: {
    copyText: vi.fn(async (_text: string): Promise<'native' | 'osc52'> => 'native'),
    openText: vi.fn(async (_text: string) => {}),
    readAttachment: vi.fn(async (_attachment: unknown): Promise<Uint8Array | undefined> => undefined),
    updateQueue: vi.fn(async (_id: unknown, _action: unknown) => false),
    restoreQueued: vi.fn(), requeue: vi.fn(),
    slashHint: vi.fn((): string | undefined => undefined),
    retheme: vi.fn(),
  },
  commandList: vi.fn(() => []),
  notice: vi.fn(), requestRender: vi.fn(), refreshEditor: vi.fn(), rethemeEditor: vi.fn(), refreshStatus: vi.fn(), republish: vi.fn(),
  keyNotices: { report: vi.fn(), clearAll: vi.fn(), dispose: vi.fn() },
  getModelCatalog: vi.fn(), setVisible: vi.fn(), present: vi.fn(), close: vi.fn(), closeChild: vi.fn(), retainOnly: vi.fn(), showPrimary: vi.fn(),
  openChild: vi.fn(async () => {}), openBtw: vi.fn(async () => {}), subagentAddress: vi.fn(),
  selectOrCreate: vi.fn(async () => {}), sessionsOpen: vi.fn(),
  suspend: vi.fn(async (run: () => Promise<unknown>) => run()),
  settingsSuspend: undefined as ((run: () => Promise<unknown>) => Promise<unknown>) | undefined,
  focus: vi.fn(), setText: vi.fn(), leaveViews: vi.fn(), handleInput: vi.fn(() => false), autocomplete: vi.fn(() => false),
  early: undefined as (() => void) | undefined,
  onEditorMount: undefined as ((ctx: Context) => void) | undefined,
}))

vi.mock('../../src/remote/app.ts', () => ({ RemoteApp: class {
  constructor(...args: unknown[]) {
    wiring.appArgs = args
    wiring.initialCommands = (args[7] as () => unknown)()
    return {
      get activeClient() { return wiring.client },
      registry: {
        get current() { return wiring.ref }, get currentReference() { return wiring.binding === undefined ? undefined : { binding: wiring.binding } },
        list: () => wiring.client === undefined ? [] : [wiring.client], get: (host: unknown) => host === wiring.client?.key ? wiring.client : undefined,
        detach: vi.fn(async () => {}),
      },
      attach: vi.fn(async () => {}), execute: wiring.execute, cancel: vi.fn(async () => {}), dispose: vi.fn(),
      selectOrCreate: wiring.selectOrCreate, subscribeTopology: (listener: () => void) => { wiring.topologies.add(listener); return () => wiring.topologies.delete(listener) },
    }
  }
} }))
vi.mock('../../src/transcript/remote-model.ts', () => ({ RemoteConversationModelSource: class {
  presentation() { return wiring.defaultFacts }
  snapshot() { return {} }
  sessionFacts() { return wiring.primaryFacts }
  imageAttachment() { return wiring.primaryImage }
  readonly getModelCatalog = wiring.getModelCatalog
  readonly setVisible = wiring.setVisible
  readonly setDefaultModel = vi.fn()
  readonly setModelCatalog = vi.fn()
  readonly dispose = wiring.disposeConversation
} }))
vi.mock('../../src/transcript/context-source.ts', () => ({ RemoteTranscriptContextSource: class {
  constructor(options: ContextOptions) { wiring.contextOptions = options; options.changed() }
  snapshot() { return wiring.contextSnapshot }
  readonly dispose = wiring.contextDispose
} }))
vi.mock('../../src/remote/editor.ts', () => ({ mountRemoteEditor: vi.fn((_ctx, _screen, _components, _colors, actions, state) => {
  wiring.actions = actions; wiring.editorState = state
  wiring.onEditorMount?.(_ctx)
  return { notice: { set: wiring.notice }, editor: { isShowingAutocomplete: wiring.autocomplete, setText: wiring.setText }, extensions: {}, focus: wiring.focus, refresh: wiring.refreshEditor, retheme: wiring.rethemeEditor, dispose: vi.fn() }
}) }))
vi.mock('../../src/remote/side-views.ts', () => ({ RemoteSideViews: class {
  constructor(_transcript: unknown, _tools: unknown, _screen: unknown, options: RemoteSideViewOptions) { wiring.sideOptions = options }
  presentation() { return wiring.sideFacts }
  selected() { return wiring.side }
  current() { return wiring.currentSide }
  sessionFacts() { return wiring.sideStatus }
  kind() { return wiring.side?.facts.kind }
  navigation() { return wiring.navigation }
  back() { return wiring.back }
  closeTarget() { return wiring.closeTarget }
  imageAttachment() { return wiring.sideImage }
  references() { return wiring.references }
  subscribe(listener: () => void) { wiring.sideListeners.add(listener); return () => wiring.sideListeners.delete(listener) }
  readonly present = wiring.present
  readonly close = wiring.close
  readonly showPrimary = wiring.showPrimary
  readonly dispose = wiring.disposeSide
} }))
vi.mock('../../src/remote/startup.ts', () => ({ RemoteStartupController: class {
  constructor(_ctx: unknown, _screen: unknown, options: StartupOptions) { wiring.startupOptions = options }
  readonly handleInput = wiring.handleInput
  flyInAt() { return 42 }
  splash() { return true }
  readonly start = vi.fn()
  readonly dispose = vi.fn()
} }))
vi.mock('../../src/remote/banner.ts', () => ({ RemoteBannerComponent: class {
  constructor(_colors: unknown, _components: unknown, _facts: unknown, options: BannerOptions) { wiring.banner = options }
} }))
vi.mock('../../src/remote/panels.ts', () => ({ RemotePanelController: class { readonly dispose = vi.fn() } }))
vi.mock('../../src/remote/interactions/plain-panels.ts', () => ({ RemotePlainPanels: class {} }))
vi.mock('../../src/remote/status.ts', () => ({ mountRemoteStatus: vi.fn((_ctx, _facts, options) => { wiring.statusOptions = options; return { refresh: wiring.refreshStatus, dispose: vi.fn(async () => {}) } }) }))
vi.mock('../../src/frontend/tool-presentations.ts', () => ({ RemoteToolPresentationCache: class {
  constructor(resolve: (ref: SessionRef) => unknown) { wiring.toolResolver = resolve }
  readonly dispose = vi.fn(async () => {})
} }))
vi.mock('../../src/remote/completion-drawer.ts', () => ({ mountRemoteCompletionDrawer: vi.fn(() => ({ dispose: vi.fn() })) }))
vi.mock('../../src/remote/features/sessions.ts', () => ({ RemoteSessionsBrowserController: class {
  constructor(_context: unknown, options: SessionsOptions) { wiring.sessions = options }
  readonly open = wiring.sessionsOpen
  readonly dispose = vi.fn()
} }))
vi.mock('../../src/remote/features.ts', () => ({ mountRemoteFeatures: vi.fn((options: FeatureOptions) => {
  wiring.features = options
  return { context: options, commands: { list: wiring.commandList }, dispose: vi.fn() }
}) }))
vi.mock('../../src/remote/features/commands.ts', () => ({ mergeRemoteFeatureCommandSources: vi.fn(() => ({ list: wiring.commandList })) }))
vi.mock('../../src/remote/configuration-composition.ts', () => ({ mountRemoteConfigurationComposition: vi.fn(() => ({ commands: [], dispose: vi.fn() })), remoteClientVersion: () => '0.1.4-rc.2' }))
vi.mock('../../src/remote/features/settings-editor.ts', () => ({ createRemoteSettingsEditor: vi.fn((options: { suspend: typeof wiring.settingsSuspend }) => { wiring.settingsSuspend = options.suspend; return vi.fn() }) }))
vi.mock('../../src/remote/operations-composition.ts', () => ({ mountRemoteOperationsComposition: vi.fn((_context: RemoteFeatureContext, options: RemoteOperationsCompositionOptions) => {
  wiring.operations = options
  return { ...options, commands: [], closeChild: wiring.closeChild, retainOnly: wiring.retainOnly, openChild: wiring.openChild, openBtw: wiring.openBtw, dispose: vi.fn() }
}) }))
vi.mock('../../src/remote/editor-composition.ts', () => ({ mountEditorComposition: vi.fn((options: EditorOptions) => {
  wiring.editorOptions = options
  return { controller: wiring.controller, dispose: vi.fn() }
}) }))
vi.mock('../../src/remote/host-composition.ts', () => ({ resolveMayflyToolPresentation: vi.fn((list: () => readonly HostClient[]) => { list(); return undefined }) }))
vi.mock('@ephemeral-ai/mayfly/transcript', () => ({
  ACTION_TOGGLE_COLLAPSE: 'mayfly.transcript.toggle-collapse',
  TRANSCRIPT_LOCALE: {}, mountTranscriptLocale: vi.fn(),
  transcriptTranslator: () => (text: string, values?: Readonly<Record<string, string | number>>) => `${wiring.locale}:${text.replace(/\{([^}]+)\}/gu, (_token, key: string) => String(values?.[key] ?? key))}`,
  observeTranscriptLocale: (_ctx: unknown, changed: () => void) => { wiring.localeChanged = changed; return wiring.offLocale },
  TranscriptPresentationPolicy: class {},
  followPresentationSettings: (_ctx: unknown, _policy: unknown, changed: () => void) => { wiring.policyChanged = changed; changed() },
  TranscriptController: class {
  constructor(options: TranscriptControllerOptions) { wiring.transcript = options; wiring.early?.() }
  readonly setView = vi.fn()
  readonly show = vi.fn()
  readonly attach = vi.fn()
  readonly refresh = vi.fn()
  readonly republish = wiring.republish
  readonly toggleRecent = wiring.toggleRecent
  readonly jumpNew = wiring.jumpNew
  readonly refreshLocale = wiring.refreshLocale
  readonly refreshPresentationPolicy = wiring.refreshPresentationPolicy
  readonly dispose = vi.fn()
} }))
vi.mock('@ephemeral-ai/mayfly/core', () => ({ name: 'core', Config: undefined, inject: [], apply(ctx: Context) {
  wiring.ctx = ctx
  ctx.provide('mayflyUiInteraction', { createNotificationOwner: () => wiring.keyNotices } as never)
  ctx.provide('mayflyScreen', { rows: 30, editorRowsFromBottom: 4, mountContentSlot: () => ({ dispose() {} }), requestRender: wiring.requestRender, suspend: wiring.suspend, leaveViews: wiring.leaveViews } as never)
  ctx.provide('mayflyComponents', {} as never)
  ctx.provide('mayflyKeymap', {
    register(actions: MayflyKeyAction[]) {
      wiring.keyActions.push(...actions)
      return () => { wiring.keyActions = wiring.keyActions.filter(action => !actions.includes(action)) }
    }, getKeys: () => ['f7'],
  } as never)
  ctx.provide('mayflyTheme', { colors: {} } as never)
  ctx.provide('mayflyUiImages', { provide(provider: typeof wiring.image) { wiring.image = provider; return () => {} } } as never)
} }))
vi.mock('@ephemeral-ai/mayfly/frontend', () => ({ name: 'frontend', Config: undefined, inject: [], apply() {}, interpolateLocaleMessage: (key: string) => key }))
vi.mock('@ephemeral-ai/mayfly/theme-dark', () => ({ name: 'theme', Config: undefined, inject: [], apply() {} }))
vi.mock('@ephemeral-ai/mayfly-ui/provider', () => ({ name: 'ui', Config: undefined, inject: [], apply() {} }))
vi.mock('@ephemeral-ai/mayfly/settings', () => ({ currentMayflySettings: () => ({ quietHints: false }) }))
vi.mock('@ephemeral-ai/mayfly/command-panels', () => ({
  INTERACTION_KEY_ACTIONS: [
    { id: 'mayfly.interaction.cycle-mode' }, { id: 'mayfly.interaction.cycle-model' },
    { id: 'mayfly.interaction.toggle-agent-view' }, { id: 'mayfly.interaction.close-agent-view' }, { id: 'other' },
  ], displayKey: (key: string) => key, interactionTranslator: () => (key: string) => key,
}))

import { runRemoteFrontend } from '../../src/remote/runtime.ts'
const local = HostKey('local')
const ref: SessionRef = { host: local, sessionId: SessionId('session') }
const child: SessionRef = { host: local, sessionId: SessionId('child') }
const binding = { sessionId: ref.sessionId, session: {} } as RemoteSideSelection['binding']
const client = { key: local, remote: { $host: { home: '/host/home' } }, state: { getSnapshot: () => ({ generation: wiring.generation }) }, sessions: { subagentAddress: wiring.subagentAddress } } as unknown as HostClient
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
let running: Promise<void> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  wiring.client = client; wiring.ref = ref; wiring.binding = binding
  wiring.side = undefined; wiring.sideFacts = undefined; wiring.sideStatus = undefined; wiring.navigation = undefined
  wiring.currentSide = undefined; wiring.closeTarget = undefined; wiring.back = false; wiring.references = []
  wiring.primaryImage = undefined; wiring.sideImage = undefined; wiring.generation = 1; wiring.early = undefined
  wiring.onEditorMount = undefined
  wiring.defaultFacts = { ref, queue: [], contextWindow: 100, contextTokens: 10 } as unknown as RemotePresentationFacts
  wiring.primaryFacts = { ref, cwd: '/local', session: undefined, values: {}, queue: [] }
  wiring.contextOptions = undefined; wiring.contextSnapshot = { window: 100, tokens: 10 }
  wiring.controller.slashHint.mockReturnValue(undefined)
  wiring.actions = undefined; wiring.editorOptions = undefined; wiring.operations = undefined; wiring.topologies.clear(); wiring.sideListeners.clear()
  wiring.keyActions = []; wiring.locale = 'en'; wiring.localeChanged = undefined; wiring.policyChanged = undefined
  wiring.execute.mockResolvedValue({ exit: false })
  wiring.controller.updateQueue.mockResolvedValue(false)
  wiring.controller.copyText.mockResolvedValue('native')
  wiring.controller.openText.mockResolvedValue(undefined)
  wiring.controller.readAttachment.mockResolvedValue(undefined)
  wiring.openChild.mockResolvedValue(undefined); wiring.openBtw.mockResolvedValue(undefined); wiring.selectOrCreate.mockResolvedValue(undefined)
})
afterEach(async () => { wiring.actions?.exit(); await running; running = undefined; vi.useRealTimers(); vi.restoreAllMocks() })
async function start(cwd: string | null = '/local/workspace', sessionId?: string) {
  running = runRemoteFrontend({ startupUrl: 'http://127.0.0.1:3080/?token=fixture', ...cwd === null ? {} : { cwd }, ...sessionId === undefined ? {} : { sessionId } })
  void running.catch(() => {})
  await vi.waitFor(() => { expect(wiring.editorOptions).toBeDefined(); expect(wiring.operations).toBeDefined() })
  await flush()
}
const selected = () => wiring.features!.hosts.current!()

describe('standalone Remote runtime wiring', () => {
  it('owns key warnings independently across prompt and Session changes, and retires them on Host changes or unload', async () => {
    wiring.onEditorMount = () => {
      wiring.keyActions.find(action => action.id.endsWith('toggle-agent-view'))!.handler!()
    }
    await start()
    expect(wiring.keyNotices.report).toHaveBeenCalledWith('toggle-agent-view', { kind: 'app', targetId: 'agent-view' }, { message: 'no other conversation is open', severity: 'warning' }, 'toggle-agent-view')
    const toggle = wiring.keyActions.find(action => action.id.endsWith('toggle-agent-view'))!.handler!
    wiring.currentSide = child
    toggle()
    expect(wiring.keyNotices.report).toHaveBeenLastCalledWith('toggle-agent-view', { kind: 'session', sessionId: child.sessionId }, { message: 'no other conversation is open', severity: 'warning' }, 'toggle-agent-view')
    wiring.currentSide = undefined
    wiring.ref = undefined
    toggle()
    expect(wiring.keyNotices.report).toHaveBeenLastCalledWith('toggle-agent-view', { kind: 'app', targetId: 'agent-view' }, { message: 'no other conversation is open', severity: 'warning' }, 'toggle-agent-view')
    for (const listener of wiring.topologies) listener()
    expect(wiring.keyNotices.clearAll).not.toHaveBeenCalled()
    wiring.client = { ...client, key: HostKey('other') }
    for (const listener of wiring.topologies) listener()
    expect(wiring.keyNotices.clearAll).toHaveBeenCalledOnce()
    wiring.client = undefined
    for (const listener of wiring.topologies) listener()
    expect(wiring.keyNotices.clearAll).toHaveBeenCalledTimes(2)
    wiring.actions!.exit()
    await running
    expect(wiring.keyNotices.dispose).toHaveBeenCalledOnce()
    wiring.keyNotices.report.mockClear()
    toggle()
    expect(wiring.keyNotices.report).not.toHaveBeenCalled()
  })

  it('rethemes the retained editor before its exact composition owner', async () => {
    await start()
    expect(wiring.rethemeEditor).toHaveBeenCalledWith(wiring.ctx!.mayflyComponents, wiring.ctx!.mayflyTheme.colors)
    expect(wiring.controller.retheme).toHaveBeenCalledWith(wiring.ctx!.mayflyComponents, wiring.ctx!.mayflyTheme.colors)
    expect(wiring.rethemeEditor.mock.invocationCallOrder[0]).toBeLessThan(wiring.controller.retheme.mock.invocationCallOrder[0]!)
  })

  it('restores native status edits to the prompt only while their exact owner remains current', async () => {
    await start()
    const edit = wiring.features!.editPrompt!
    expect(edit('/goal edit retired', () => false)).toBe(false)
    expect(wiring.leaveViews).not.toHaveBeenCalled()
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(edit('/goal edit replaced', current)).toBe(false)
    expect(wiring.leaveViews).toHaveBeenCalledOnce()
    expect(wiring.setText).not.toHaveBeenCalled()
    expect(edit('/goal edit native objective', () => true)).toBe(true)
    expect(wiring.setText).toHaveBeenCalledExactlyOnceWith('/goal edit native objective')
    expect(wiring.focus).toHaveBeenCalledOnce()
    wiring.actions!.exit()
    await running
    expect(edit('/goal edit after unload', () => true)).toBe(false)
    wiring.actions!.onError(new Error('late input failure'))
    expect(wiring.setText).toHaveBeenCalledOnce()
    expect(wiring.notice).not.toHaveBeenCalled()
  })

  it('borrows exact displayed facts and Host for transcript context and retires before its sources', async () => {
    let beforeApp: ReturnType<ContextOptions['read']> | undefined
    wiring.early = () => { beforeApp = wiring.contextOptions!.read() }
    await start()
    expect(beforeApp).toEqual({ facts: wiring.primaryFacts, client: undefined })
    const context = wiring.contextOptions!
    expect(context.read()).toEqual({ facts: wiring.primaryFacts, client })
    expect(context.read().facts.ref).toBe(ref)
    expect(wiring.transcript!.context!()).toBe(wiring.contextSnapshot)
    context.changed()
    expect(wiring.republish).toHaveBeenCalledOnce()
    const childFacts: RemoteSessionFactsSnapshot = { ref: child, cwd: '/child', session: undefined, values: { contextPressure: { pressureTokens: 40 } }, queue: [] }
    wiring.sideStatus = childFacts
    expect(context.read()).toEqual({ facts: childFacts, client })
    expect(context.read().facts.ref).toBe(child)
    wiring.sideStatus = undefined
    wiring.primaryFacts = { ...wiring.primaryFacts, ref: undefined }
    expect(context.read()).toEqual({ facts: wiring.primaryFacts, client: undefined })
    wiring.primaryFacts = { ...wiring.primaryFacts, ref: { host: HostKey('foreign'), sessionId: ref.sessionId } }
    expect(context.read()).toEqual({ facts: wiring.primaryFacts, client: undefined })
    wiring.controller.slashHint.mockReturnValue('no matching command: /unknown')
    expect(wiring.editorState!()).toMatchObject({ slashHint: 'no matching command: /unknown' })
    wiring.actions!.exit()
    await running
    context.changed()
    expect(wiring.republish).toHaveBeenCalledOnce()
    expect(wiring.contextDispose).toHaveBeenCalledOnce()
    expect(wiring.contextDispose.mock.invocationCallOrder[0]).toBeLessThan(wiring.disposeSide.mock.invocationCallOrder[0]!)
    expect(wiring.contextDispose.mock.invocationCallOrder[0]).toBeLessThan(wiring.disposeConversation.mock.invocationCallOrder[0]!)
  })

  it('forwards native transcript focus and queued-row facts only while the runtime owns them', async () => {
    await start()
    const mode = vi.fn(), row = vi.fn()
    const offMode = wiring.ctx!.on('mayfly/focus-mode-changed', mode)
    const offRow = wiring.ctx!.on('mayfly/focus-row-changed', row)
    const focusMode = wiring.transcript!.focusMode!
    const focusRow = wiring.transcript!.focusRow!
    for (const next of ['conversation', 'search', 'search-select', 'prompt'] as const) focusMode(next)
    for (const next of ['queued', 'steering', undefined] as const) focusRow(next)
    expect(mode.mock.calls.map(call => call[0])).toEqual(['conversation', 'search', 'search-select', 'prompt'])
    expect(row.mock.calls.map(call => call[0])).toEqual(['queued', 'steering', undefined])
    wiring.actions!.exit()
    await running
    focusMode('conversation')
    focusRow('queued')
    await flush()
    expect(mode).toHaveBeenCalledTimes(4)
    expect(row).toHaveBeenCalledTimes(3)
    offMode(); offRow()
  })

  it('owns transcript expansion, new-message, help, locale and presentation registrations through unload', async () => {
    let callback!: (event: string) => () => void
    wiring.onEditorMount = ctx => {
      const subscriptions = vi.spyOn(ctx, 'on')
      callback = event => subscriptions.mock.calls.find(call => call[0] === event)![1] as () => void
    }
    await start()
    const toggle = wiring.keyActions.find(action => action.id === 'mayfly.transcript.toggle-collapse')!
    expect(toggle).toMatchObject({ keys: 'ctrl+o', description: 'en:Toggle detail expansion (tool output, long messages)' })
    toggle.handler!()
    expect(wiring.toggleRecent).toHaveBeenCalledOnce()
    expect(wiring.requestRender).toHaveBeenCalledWith(true)
    const newMessages = callback('mayfly/request-new-messages')
    newMessages()
    expect(wiring.jumpNew).toHaveBeenCalledOnce()
    wiring.policyChanged!()
    expect(wiring.refreshPresentationPolicy).toHaveBeenCalledOnce()
    const locale = wiring.localeChanged!
    wiring.locale = 'zh'
    locale()
    expect(wiring.refreshLocale).toHaveBeenCalledOnce()
    expect(wiring.keyActions.filter(action => action.id === toggle.id)).toEqual([
      expect.objectContaining({ description: 'zh:Toggle detail expansion (tool output, long messages)' }),
    ])
    const help = callback('mayfly/request-help')
    help()
    await flush()
    expect(wiring.execute).toHaveBeenCalledWith('/help')
    wiring.execute.mockRejectedValueOnce(new Error('help unavailable'))
    help()
    await flush()
    expect(wiring.notice).toHaveBeenLastCalledWith('help unavailable', 'error')
    wiring.execute.mockRejectedValueOnce('help refused')
    help()
    await flush()
    expect(wiring.notice).toHaveBeenLastCalledWith('help refused', 'error')
    let reject!: (error: Error) => void
    wiring.execute.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    help()
    wiring.actions!.exit()
    await running
    const notices = wiring.notice.mock.calls.length
    const renders = wiring.requestRender.mock.calls.length
    reject(new Error('late old help failed'))
    toggle.handler!(); newMessages(); help(); locale()
    await flush()
    expect(wiring.notice).toHaveBeenCalledTimes(notices)
    expect(wiring.requestRender).toHaveBeenCalledTimes(renders)
    expect(wiring.toggleRecent).toHaveBeenCalledOnce()
    expect(wiring.jumpNew).toHaveBeenCalledOnce()
    expect(wiring.refreshLocale).toHaveBeenCalledOnce()
    expect(wiring.offLocale).toHaveBeenCalledOnce()
    expect(wiring.keyActions).toEqual([])
  })

  it('binds exact displayed selections, model catalogs, key actions and disposable topology listeners', async () => {
    await start('/local/workspace', 'native-initial')
    expect(wiring.initialCommands).toEqual([])
    expect(wiring.selectOrCreate).toHaveBeenCalledWith('native-initial', '/local/workspace')
    wiring.toolResolver!(ref)
    expect(selected()).toMatchObject({ ref, binding, client, access: 'interactive', kind: 'primary' })
    expect(wiring.features!.hosts.active!()).toBe(client)
    expect(wiring.features!.hosts.list()).toEqual([client])
    expect(wiring.keyActions.map(action => action.id)).toEqual(['mayfly.interaction.toggle-agent-view', 'mayfly.interaction.close-agent-view', 'other', 'mayfly.transcript.toggle-collapse'])
    const key = (id: string) => wiring.keyActions.find(action => action.id.endsWith(id))!.handler!()
    key('toggle-agent-view')
    expect(wiring.keyNotices.report).toHaveBeenCalledWith('toggle-agent-view', { kind: 'session', sessionId: ref.sessionId }, { message: 'no other conversation is open', severity: 'warning' }, 'toggle-agent-view')
    wiring.back = true; wiring.keyNotices.report.mockClear(); key('toggle-agent-view'); expect(wiring.keyNotices.report).not.toHaveBeenCalled()
    key('close-agent-view'); expect(wiring.closeChild).not.toHaveBeenCalled()
    wiring.closeTarget = child; key('close-agent-view'); expect(wiring.closeChild).toHaveBeenCalledWith(child)
    wiring.side = { ref: child, binding, facts: { kind: 'subagent', access: 'readonly' } }
    expect(selected()).toMatchObject({ ref: child, binding, access: 'readonly', kind: 'subagent' })
    expect(wiring.operations!.primary!()).toEqual({ ref, binding, client })
    wiring.operations!.showPrimary!()
    expect(wiring.showPrimary).toHaveBeenCalledOnce()
    const changed = vi.fn(), off = wiring.features!.hosts.subscribe(changed)
    for (const listener of wiring.topologies) listener()
    for (const listener of wiring.sideListeners) listener()
    expect(changed).toHaveBeenCalledTimes(2); off()
    wiring.sideOptions!.changed!(); expect(wiring.refreshStatus).toHaveBeenCalled(); expect(wiring.refreshEditor).toHaveBeenCalled()
    wiring.sideOptions!.evicted!(child); expect(wiring.closeChild).toHaveBeenCalledWith(child)
    wiring.sideOptions!.retainOnly!([child]); expect(wiring.retainOnly).toHaveBeenCalledWith([child])
    wiring.sideOptions!.primaryVisible!(false); expect(wiring.setVisible).toHaveBeenCalledWith(false)
    expect(wiring.sideOptions!.client!(child)).toBe(client)
    wiring.sideOptions!.modelCatalog!(local); wiring.operations!.modelCatalog!(local)
    expect(wiring.getModelCatalog).toHaveBeenCalledWith(local)
    wiring.ref = undefined; wiring.side = undefined; expect(selected()).toBeUndefined(); expect(wiring.operations!.primary!()).toBeUndefined()
    wiring.ref = ref; wiring.binding = undefined; expect(selected()).toBeUndefined(); expect(wiring.operations!.primary!()).toBeUndefined()
    wiring.binding = binding; wiring.client = undefined; expect(selected()).toBeUndefined(); expect(wiring.operations!.primary!()).toBeUndefined()
    expect(wiring.sideOptions!.client!(child)).toBeUndefined()
  })

  it('preserves primary replacement, session browser, startup and editor presentation callbacks', async () => {
    await start()
    expect(wiring.appArgs[4]).toBe('/local/workspace')
    expect(wiring.operations!.localCwd).toBe(process.cwd())
    expect(wiring.editorOptions!.localCwd).toBe(process.cwd())
    const home = wiring.banner!
    expect(home.identity!()).toBe(client); expect(home.home!()).toBe('/host/home'); expect(home.directory!()).toBe('/local/workspace')
    expect(home.colors!()).toEqual({}); expect(home.components!()).toEqual({}); expect(home.flyInAt!()).toBe(42); expect(home.splash!()).toBe(true)
    expect(wiring.statusOptions!.home!()).toBe('/host/home'); expect(wiring.statusOptions!.directory!()).toBe('/local/workspace')
    expect(wiring.startupOptions!.client()).toBe(client); expect(wiring.startupOptions!.current()).toBe(ref); expect(wiring.startupOptions!.directory()).toBe('/local/workspace')
    const stop = wiring.startupOptions!.subscribe(vi.fn()); stop()
    expect(wiring.startupOptions!.autocomplete()).toBe(false); wiring.autocomplete.mockReturnValueOnce(true); expect(wiring.startupOptions!.autocomplete()).toBe(true)
    await wiring.startupOptions!.resume('resume-native'); expect(wiring.selectOrCreate).toHaveBeenCalledWith('resume-native', '/local/workspace')
    expect(wiring.editorState!()).toMatchObject({ view: { kind: 'primary', access: 'interactive' }, quietHints: false })
    wiring.side = { ref: child, binding, facts: { kind: 'btw', access: 'readonly', label: 'Cold leaf' } }
    wiring.navigation = { counterpart: 'primary', close: 'subagent' }
    expect(wiring.editorState!()).toMatchObject({ view: wiring.side.facts, title: 'Cold leaf', toggle: 'f7 main · f7 detach' })
    wiring.side = { ...wiring.side, facts: { ...wiring.side.facts, access: 'interactive' } }
    wiring.sideFacts = { ...wiring.defaultFacts, title: 'Native live title' }
    expect(wiring.editorState!()).toMatchObject({ view: wiring.side.facts, title: 'Native live title' })
    wiring.side = { ...wiring.side, facts: { kind: 'subagent', access: 'resumable' } }
    expect(wiring.editorState!()).toMatchObject({ title: 'Native live title' })
    wiring.navigation = { counterpart: 'btw', close: 'btw' }
    expect(wiring.editorState!()).toMatchObject({ toggle: 'f7 btw · f7 close' })
    wiring.editorOptions!.focusEditor!(); expect(wiring.focus).toHaveBeenCalled()
    wiring.editorOptions!.selection!(); const off = wiring.editorOptions!.subscribeSelection!(vi.fn()); off()
    wiring.editorOptions!.startupKey!('x', 'x'); expect(wiring.handleInput).toHaveBeenCalledWith('x', 'x')
    const open = wiring.appArgs[5] as { open: (...args: unknown[]) => void }
    const selectSession = vi.fn()
    const browserCaller = new AbortController()
    open.open(client, ref, selectSession, browserCaller.signal)
    expect(wiring.sessionsOpen).toHaveBeenCalledWith(client, ref, selectSession, browserCaller.signal)
    const displayed = wiring.appArgs[6] as () => unknown
    expect(displayed()).toMatchObject({ ref: child, presentation: wiring.defaultFacts })
    wiring.side = undefined; expect(displayed()).toBeUndefined()
    ;(wiring.appArgs[7] as () => unknown)(); expect(wiring.commandList).toHaveBeenCalledWith(true)
    const offAppSide = (wiring.appArgs[8] as (listener: () => void) => () => void)(vi.fn()); offAppSide()
    ;(wiring.appArgs[9] as () => void)(); expect(wiring.showPrimary).toHaveBeenCalled()
    wiring.references = [child]
    for (const listener of wiring.topologies) listener()
    expect(wiring.closeChild).not.toHaveBeenCalled()
    wiring.binding = { ...binding }
    for (const listener of wiring.topologies) listener()
    expect(wiring.closeChild).toHaveBeenCalledWith(child)
    expect(wiring.sessions!.home!(client)).toBe('/host/home'); expect(wiring.sessions!.directory!()).toBe('/local/workspace')
    await wiring.sessions!.openChild!(client, { native: 'address' } as never, new AbortController().signal)
    expect(wiring.openChild).toHaveBeenCalled()
    const run = vi.fn(async () => 'edited'); await wiring.settingsSuspend!(run); expect(wiring.suspend).toHaveBeenCalledWith(run)
  })

  it('uses captured exact attachment data for primary and side views and lets missing bytes remain unavailable', async () => {
    await start()
    await expect(wiring.image!('missing')).resolves.toBeUndefined()
    wiring.primaryImage = { attachmentId: 'native-image', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'photo.png', originalDimensions: { width: 2, height: 2 } }
    await expect(wiring.image!('primary')).resolves.toBeUndefined()
    expect(wiring.controller.readAttachment).toHaveBeenCalledWith(wiring.primaryImage)
    wiring.controller.readAttachment.mockResolvedValueOnce(new Uint8Array([1, 2]))
    await expect(wiring.image!('primary')).resolves.toEqual({ data: new Uint8Array([1, 2]), mediaType: 'image/png' })
    wiring.currentSide = child
    wiring.sideImage = { attachmentId: 'side-image', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 }
    await wiring.image!('side'); expect(wiring.controller.readAttachment).toHaveBeenLastCalledWith(wiring.sideImage)
    wiring.operations!.present!(child, binding, { kind: 'subagent', access: 'readonly' })
    expect(wiring.present).toHaveBeenCalledWith(binding, { ref: child, cwd: '' }, { kind: 'subagent', access: 'readonly' })
    wiring.operations!.present!(child, binding, { kind: 'btw', access: 'interactive', cwd: '/native/child' })
    expect(wiring.present).toHaveBeenLastCalledWith(binding, { ref: child, cwd: '/native/child' }, expect.anything())
    wiring.operations!.closePresent!(child); expect(wiring.close).toHaveBeenCalledWith(child)
    await wiring.operations!.copy!('through clipboard'); expect(wiring.controller.copyText).toHaveBeenCalledWith('through clipboard')
  })

  it('routes copy, open, decision requests and exact queue actions with undo expiry and errors', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000)
    await start()
    const rows = wiring.transcript!.rows!
    rows.copy!('hello', 'text'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('en:Copied 5 characters', 'success')
    wiring.controller.copyText.mockResolvedValueOnce('osc52'); rows.copy!('{}', 'raw'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('en:Copied 2 characters of JSON (unverified)', 'success')
    rows.copy!('{}', 'raw'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('en:Copied 2 characters of JSON', 'success')
    wiring.locale = 'zh'
    wiring.controller.copyText.mockResolvedValueOnce('osc52'); rows.copy!('hello', 'text'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('zh:Copied 5 characters (unverified)', 'success')
    for (const error of [new Error('clipboard failed'), 'clipboard refused']) { wiring.controller.copyText.mockRejectedValueOnce(error); rows.copy!('a', 'text'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('zh:Could not copy', 'error', error instanceof Error ? error.message : error) }
    rows.open!('native detail'); await flush(); expect(wiring.controller.openText).toHaveBeenCalledWith('native detail')
    for (const error of [new Error('open failed'), 'open refused']) { wiring.controller.openText.mockRejectedValueOnce(error); rows.open!('x'); await flush(); expect(wiring.notice).toHaveBeenCalledWith(error instanceof Error ? error.message : error, 'error') }
    const facts = wiring.defaultFacts as unknown as { ref: SessionRef | undefined, queue: Array<{ id: string, text: string, lane: 'turn' | 'step' }> }
    facts.queue = [{ id: 'queued-native', text: 'queued draft', lane: 'step' }]
    expect(wiring.transcript!.queued()).toEqual(facts.queue)
    rows.queued!('undo', undefined); rows.queued!('edit', undefined); await flush(); expect(wiring.notice).toHaveBeenCalledWith('The agent already read it')
    rows.queued!('edit', 'queued-native'); await flush(); expect(wiring.controller.restoreQueued).not.toHaveBeenCalled()
    wiring.controller.updateQueue.mockResolvedValue(true)
    rows.queued!('edit', 'queued-native'); await flush(); expect(wiring.controller.restoreQueued).toHaveBeenCalledWith('queued draft')
    rows.queued!('steer', 'queued-native'); await flush(); expect(wiring.controller.updateQueue).toHaveBeenLastCalledWith('queued-native', { kind: 'steer' })
    rows.queued!('cancel', 'queued-native'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('Cancelled · u undo')
    rows.queued!('undo', undefined); await flush(); expect(wiring.controller.requeue).toHaveBeenCalledWith('queued draft', 'step')
    rows.queued!('cancel', 'queued-native'); await flush(); vi.setSystemTime(10000); rows.queued!('undo', undefined); await flush(); expect(wiring.controller.requeue).toHaveBeenCalledOnce()
    vi.setSystemTime(11000); rows.queued!('cancel', 'queued-native'); await flush(); facts.ref = child; rows.queued!('undo', undefined); await flush(); expect(wiring.controller.requeue).toHaveBeenCalledOnce()
    facts.ref = undefined; rows.queued!('undo', undefined); await flush()
    rows.queued!('cancel', 'queued-native'); await flush(); expect(wiring.notice).toHaveBeenCalledWith('The selected Session changed before the queue mutation', 'error')
    facts.ref = ref
    for (const error of [new Error('queue failed'), 'queue refused']) { wiring.controller.updateQueue.mockRejectedValueOnce(error); rows.queued!('cancel', 'queued-native'); await flush(); expect(wiring.notice).toHaveBeenCalledWith(error instanceof Error ? error.message : error, 'error') }
    wiring.ctx!.emit('mayfly/decision-requests-changed', 'approval', [{ type: 'approval', toolName: 'bash' }])
    wiring.ctx!.emit('mayfly/decision-requests-changed', 'plan', [{ type: 'plan', toolName: 'plan' }])
    expect(wiring.transcript!.requests!()).toEqual([{ type: 'approval', toolName: 'bash' }, { type: 'plan', toolName: 'plan' }]); expect(wiring.republish).toHaveBeenCalledTimes(2)
  })

  it.each(['binding', 'host', 'generation', 'shutdown'] as const)('fences pending row-copy feedback after exact %s retirement', async retirement => {
    await start()
    const rows = wiring.transcript!.rows!
    const copied = Promise.withResolvers<'native' | 'osc52'>()
    const failed = Promise.withResolvers<'native' | 'osc52'>()
    wiring.controller.copyText.mockReturnValueOnce(copied.promise).mockReturnValueOnce(failed.promise)
    rows.copy!('old success', 'text')
    rows.copy!('old failure', 'raw')
    if (retirement === 'binding') wiring.binding = { ...binding }
    if (retirement === 'host') wiring.client = undefined
    if (retirement === 'generation') wiring.generation += 1
    if (retirement === 'shutdown') { wiring.actions!.exit(); await running }
    wiring.notice.mockClear()
    copied.resolve('native')
    failed.reject(new Error('old clipboard failed'))
    await flush()
    expect(wiring.notice).not.toHaveBeenCalled()
    if (retirement === 'shutdown') {
      rows.copy!('captured after unload', 'text')
      expect(wiring.controller.copyText).toHaveBeenCalledTimes(2)
    }
  })

  it.each(['binding', 'generation', 'shutdown'] as const)('retires open and queue continuations after %s replacement', async retirement => {
    await start()
    const rows = wiring.transcript!.rows!
    const opened = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<boolean>()
    const edited = Promise.withResolvers<boolean>()
    const cancelled = Promise.withResolvers<boolean>()
    wiring.defaultFacts = { ...wiring.defaultFacts, queue: [{ id: 'queued-native', text: 'old draft', lane: 'turn' }] } as unknown as RemotePresentationFacts
    wiring.controller.openText.mockReturnValueOnce(opened.promise)
    wiring.controller.updateQueue.mockReturnValueOnce(failed.promise).mockReturnValueOnce(edited.promise).mockReturnValueOnce(cancelled.promise)
    rows.open!('old detail')
    rows.queued!('steer', 'queued-native')
    rows.queued!('edit', 'queued-native')
    rows.queued!('cancel', 'queued-native')
    if (retirement === 'binding') wiring.binding = { ...binding }
    if (retirement === 'generation') wiring.generation += 1
    if (retirement === 'shutdown') { wiring.actions!.exit(); await running }
    wiring.notice.mockClear()
    opened.reject(new Error('late open failed'))
    failed.reject(new Error('late queue failed'))
    edited.resolve(true)
    cancelled.resolve(true)
    await flush()
    expect(wiring.notice).not.toHaveBeenCalled()
    expect(wiring.controller.restoreQueued).not.toHaveBeenCalled()
    rows.queued!('undo', undefined)
    expect(wiring.controller.requeue).not.toHaveBeenCalled()
    if (retirement === 'shutdown') {
      rows.open!('after unload')
      rows.queued!('cancel', 'queued-native')
      expect(wiring.controller.openText).toHaveBeenCalledOnce()
      expect(wiring.controller.updateQueue).toHaveBeenCalledTimes(3)
    }
  })

  it('keeps row-copy feedback app-scoped without a selected Session', async () => {
    wiring.ref = undefined; wiring.binding = undefined
    await start()
    wiring.transcript!.rows!.copy!('sessionless', 'text')
    await flush()
    expect(wiring.notice).toHaveBeenCalledWith('en:Copied 11 characters', 'success')
  })

  it('fences reopened child and startup failures by active Host, native generation and shutdown', async () => {
    await start()
    wiring.subagentAddress.mockReturnValue(undefined)
    wiring.sideOptions!.reopen!(child, { kind: 'subagent', access: 'resumable' }); await flush()
    expect(wiring.notice).toHaveBeenCalledWith('The native child address is unavailable')
    const address = { path: ['native-child'] }
    wiring.sideOptions!.reopen!(child, { kind: 'subagent', access: 'resumable', address: address as never }); await flush()
    expect(wiring.openChild).toHaveBeenCalledWith(client, address, expect.any(AbortSignal))
    wiring.subagentAddress.mockReturnValue(address)
    wiring.sideOptions!.reopen!(child, { kind: 'subagent', access: 'resumable' }); await flush()
    expect(wiring.openChild).toHaveBeenCalledWith(client, address, expect.any(AbortSignal))
    wiring.openBtw.mockRejectedValueOnce('btw refused')
    wiring.sideOptions!.reopen!(child, { kind: 'btw', access: 'resumable' }); await flush(); expect(wiring.notice).toHaveBeenCalledWith('btw refused')
    for (const error of [new Error('resume failed'), 'resume refused']) { wiring.selectOrCreate.mockRejectedValueOnce(error); await wiring.startupOptions!.resume('native-session'); expect(wiring.notice).toHaveBeenCalledWith(error instanceof Error ? error.message : error) }
    const oldResume = Promise.withResolvers<void>()
    wiring.selectOrCreate.mockReturnValueOnce(oldResume.promise)
    const resume = wiring.startupOptions!.resume('old-generation')
    wiring.generation += 1; wiring.notice.mockClear(); oldResume.reject(new Error('retired resume failed')); await resume
    expect(wiring.notice).not.toHaveBeenCalled()
    for (const action of ['generation', 'host', 'shutdown'] as const) {
      wiring.client = client
      const pending = Promise.withResolvers<void>()
      wiring.openChild.mockReturnValueOnce(pending.promise)
      wiring.sideOptions!.reopen!(child, { kind: 'subagent', access: 'resumable', address: address as never })
      if (action === 'generation') wiring.generation += 1
      if (action === 'host') wiring.client = undefined
      if (action === 'shutdown') { wiring.actions!.exit(); await running }
      wiring.notice.mockClear(); pending.reject(new Error('retired child failed')); await flush(); expect(wiring.notice).not.toHaveBeenCalled()
    }
    wiring.client = undefined; wiring.sideOptions!.reopen!(child, { kind: 'subagent', access: 'resumable' })
    await wiring.startupOptions!.resume('after shutdown')
  })

  it('covers sessionless process defaults and early callbacks before controller assignment', async () => {
    wiring.client = undefined; wiring.ref = undefined; wiring.binding = undefined
    wiring.early = () => {
      wiring.transcript!.rows!.queued!('cancel', 'not-mounted')
      wiring.transcript!.rows!.copy!('not-mounted', 'text')
    }
    await start(null)
    expect(wiring.banner!.identity!()).toBeUndefined(); expect(wiring.banner!.home!()).toBe(''); expect(wiring.banner!.directory!()).toBe(process.cwd())
    expect(wiring.sessions!.home!({ remote: { $host: {} } } as never)).toBe('')
    expect(wiring.sessions!.directory!()).toBe(process.cwd())
    expect(wiring.startupOptions!.directory()).toBe(process.cwd())
    expect(wiring.statusOptions!.home!()).toBe(''); expect(wiring.statusOptions!.directory!()).toBe(process.cwd())
    wiring.toolResolver!(ref)
    expect(selected()).toBeUndefined()
    await wiring.startupOptions!.resume('sessionless')
    expect(wiring.controller.updateQueue).not.toHaveBeenCalled()
  })
})
