import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import * as Core from '@ephemeral-ai/mayfly/core'
import * as ThemeDark from '@ephemeral-ai/mayfly/theme-dark'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { currentMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { INTERACTION_KEY_ACTIONS, displayKey, interactionTranslator } from '@ephemeral-ai/mayfly/command-panels'
import { TranscriptController, type TranscriptControllerOptions } from '@ephemeral-ai/mayfly/transcript'

type QueueAction = Parameters<NonNullable<TranscriptControllerOptions['rows']>['queued']>[0]
type DecisionRequests = ReturnType<NonNullable<TranscriptControllerOptions['requests']>>
import type { SessionRef } from '../client/types.ts'
import { RemoteToolPresentationCache } from '../frontend/tool-presentations.ts'
import { RemoteConversationModelSource } from '../transcript/remote-model.ts'
import { RemoteApp } from './app.ts'
import { RemoteSessionsBrowserController } from './features/sessions.ts'
import { createRemoteSettingsEditor } from './features/settings-editor.ts'
import { RemoteBannerComponent } from './banner.ts'
import { mountRemoteConfigurationComposition, remoteClientVersion, type RemoteConfigurationCompositionHandle } from './configuration-composition.ts'
import { mountEditorComposition, type EditorCompositionHandle } from './editor-composition.ts'
import { mountRemoteCompletionDrawer } from './completion-drawer.ts'
import { mountRemoteEditor, type RemoteEditorHandle } from './editor.ts'
import { mountRemoteFeatures, type RemoteFeatureHandle } from './features.ts'
import { mergeRemoteFeatureCommandSources, type RemoteFeatureCommandSource } from './features/commands.ts'
import { resolveMayflyToolPresentation } from './host-composition.ts'
import { RemotePlainPanels } from './interactions/plain-panels.ts'
import { mountRemoteOperationsComposition, type RemoteOperationsCompositionHandle } from './operations-composition.ts'
import { RemotePanelController } from './panels.ts'
import { RemoteSideViews } from './side-views.ts'
import { mountRemoteStatus, type RemoteStatusHandle } from './status.ts'

/** Inputs for one independent Mayfly Frontend process. */
export interface RemoteFrontendOptions {
  readonly startupUrl: string
  readonly hostId?: string
  readonly sessionId?: string
  readonly cwd?: string
  readonly task?: string
}

/** Run the standalone TUI until the user detaches or exits, then release every Client and the TTY. */
export async function runRemoteFrontend(options: RemoteFrontendOptions): Promise<void> {
  const ctx = new Context()
  const apps: RemoteApp[] = []
  let editor: RemoteEditorHandle | undefined
  let completionDrawer: { dispose(): void } | undefined
  let editorComposition: EditorCompositionHandle | undefined
  let panels: RemotePanelController | undefined
  let features: RemoteFeatureHandle | undefined
  let configuration: RemoteConfigurationCompositionHandle | undefined
  let operations: RemoteOperationsCompositionHandle | undefined
  let sideViews: RemoteSideViews | undefined
  let commandSource: RemoteFeatureCommandSource | undefined
  let toolPresentations: RemoteToolPresentationCache | undefined
  let conversation: RemoteConversationModelSource | undefined
  let transcript: TranscriptController | undefined
  let status: RemoteStatusHandle | undefined
  let sessionsBrowser: RemoteSessionsBrowserController | undefined
  let cancelled: { readonly ref: SessionRef, readonly text: string, readonly lane: 'turn' | 'step', readonly at: number } | undefined
  let stopped = false
  const lifetime = new AbortController()
  const done = Promise.withResolvers<void>()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    done.resolve()
  }
  const sigint = (): void => { stop() }
  const sigterm = (): void => { stop() }
  process.once('SIGINT', sigint)
  process.once('SIGTERM', sigterm)
  try {
    await ctx.plugin(MayflyUiProvider)
    await ctx.plugin(Frontend)
    await ctx.plugin(ThemeDark)
    await ctx.plugin(Core)
    ctx.effect(() => ctx.mayflyKeymap.register(INTERACTION_KEY_ACTIONS
      .filter(action => action.id !== 'mayfly.interaction.cycle-mode' && action.id !== 'mayfly.interaction.cycle-model')
      .map(action => action.id === 'mayfly.interaction.toggle-agent-view' ? {
        ...action, handler: () => {
          if (sideViews?.back() !== true) editor?.notice.set('no other conversation is open')
        },
      } : action.id === 'mayfly.interaction.close-agent-view' ? {
        ...action, handler: () => {
          const target = sideViews?.closeTarget()
          if (target !== undefined) operations?.closeChild(target)
        },
      } : action)))
    const screen = ctx.mayflyScreen
    let app: RemoteApp | undefined
    const displayedFacts = () => sideViews?.presentation() ?? conversation!.presentation()
    const displayedSelection = () => {
      const side = sideViews?.selected()
      const ref = side?.ref ?? app?.registry.current
      const binding = side?.binding ?? app?.registry.currentReference?.binding
      const client = ref === undefined ? undefined : app?.registry.get(ref.host)
      return ref === undefined || binding === undefined || client === undefined ? undefined
        : { ref, binding, client, access: side?.facts.access ?? 'interactive' as const }
    }
    toolPresentations = new RemoteToolPresentationCache(ref => resolveMayflyToolPresentation(() => app?.registry.list() ?? [], ref))
    conversation = new RemoteConversationModelSource(toolPresentations, () => transcript?.refresh(), {
      defaultCwd: options.cwd ?? process.cwd(),
      onPresentation: () => {
        status?.refresh()
        editor?.refresh()
        screen.requestRender()
      },
      onCommandResult: (result) => {
        if (result.text !== undefined) editor?.notice.set(result.text)
      },
    })
    const bannerSlot = screen.mountContentSlot('transcript.prelude', new RemoteBannerComponent(
      ctx.mayflyTheme.colors,
      ctx.mayflyComponents,
      displayedFacts,
      {
        home: () => app?.activeClient?.remote.$host.home ?? '',
        directory: () => options.cwd ?? process.cwd(),
        colors: () => ctx.mayflyTheme.colors,
        components: () => ctx.mayflyComponents,
      },
    ))
    ctx.effect(() => () => bannerSlot.dispose())
    const imageRefs = new Map<string, { readonly attachmentId: string, readonly mediaType: string }>()
    const queueAction = async (action: QueueAction, id: string | undefined): Promise<void> => {
      const controller = editorComposition?.controller
      if (controller === undefined) return
      const current = displayedFacts()
      if (action === 'undo') {
        if (cancelled === undefined || Date.now() - cancelled.at > 8_000 || !sameRef(current.ref, cancelled.ref)) return
        controller.requeue(cancelled.text, cancelled.lane)
        cancelled = undefined
        return
      }
      const item = id === undefined ? undefined : current.queue.find(candidate => candidate.id === id)
      if (item === undefined) {
        editor?.notice.set('The agent already read it')
        return
      }
      if (action === 'edit') {
        if (await controller.updateQueue(MessageId(item.id), { kind: 'remove' })) controller.restoreQueued(item.text)
        return
      }
      if (action === 'steer') {
        await controller.updateQueue(MessageId(item.id), { kind: 'steer' })
        return
      }
      if (await controller.updateQueue(MessageId(item.id), { kind: 'remove' })) {
        cancelled = { ref: selectedRef(current.ref), text: item.text, lane: item.lane, at: Date.now() }
        editor?.notice.set('Cancelled · u undo')
      }
    }
    const requests: Record<'approval' | 'plan', DecisionRequests> = { approval: [], plan: [] }
    transcript = new TranscriptController({
      t: Frontend.interpolateLocaleMessage,
      queued: () => displayedFacts().queue,
      requests: () => [...requests.approval, ...requests.plan],
      tick: ctx.mayflyTick,
      context: () => ({
        window: displayedFacts().contextWindow,
        tokens: displayedFacts().contextTokens,
      }),
      imageRefs,
      rows: {
        copy: (text, mode) => {
          void editorComposition?.controller.copyText(text).then(method => {
            editor?.notice.set(`${method === 'native' ? 'Copied' : 'Copied (unverified)'} ${String(text.length)} characters${mode === 'raw' ? ' of JSON' : ''}`)
          }).catch((error: unknown) => { editor?.notice.set(error instanceof Error ? error.message : String(error)) })
        },
        open: (text) => {
          void editorComposition?.controller.openText(text).catch((error: unknown) => {
            editor?.notice.set(error instanceof Error ? error.message : String(error))
          })
        },
        queued: (action, id) => {
          void queueAction(action, id).catch((error: unknown) => {
            editor?.notice.set(error instanceof Error ? error.message : String(error))
          })
        },
      },
    })
    ctx.effect(() => ctx.on('mayfly/decision-requests-changed', (source, next) => {
      requests[source] = next
      transcript?.republish()
    }))
    transcript.setView('remote', () => conversation!.snapshot())
    transcript.show('remote')
    transcript.attach(screen)

    const execute = async (text: string): Promise<void> => {
      const result = await app!.execute(text)
      if (result.exit) stop()
    }
    editor = mountRemoteEditor(ctx, screen, ctx.mayflyComponents, ctx.mayflyTheme.colors, {
      submit: execute,
      onError: (error) => { editor?.notice.set(error instanceof Error ? error.message : String(error)) },
      cancel: () => app!.cancel(),
      exit: stop,
    }, () => {
      const side = sideViews?.selected()
      const facts = displayedFacts()
      const settings = currentMayflySettings(ctx)
      const navigation = sideViews?.navigation()
      const t = interactionTranslator(ctx)
      const keyHint = (id: string) => ctx.mayflyKeymap.getKeys(id).map(displayKey).join('/')
      return {
        view: side === undefined ? { kind: 'primary', access: 'interactive' } : side.facts,
        title: facts.title,
        running: facts.active,
        quietHints: settings.quietHints,
        hostKey: facts.ref?.host,
        sessionId: facts.ref?.sessionId,
        toggle: navigation === undefined ? undefined : `${keyHint('mayfly.interaction.toggle-agent-view')} ${t(navigation.counterpart === 'primary' ? 'main' : navigation.counterpart)} · ${keyHint('mayfly.interaction.close-agent-view')} ${t(navigation.close === 'subagent' ? 'detach' : 'close')}`,
      }
    })
    completionDrawer = mountRemoteCompletionDrawer(ctx, screen, editor.editor, ctx.mayflyTheme.colors, ctx.mayflyComponents)
    sideViews = new RemoteSideViews(transcript, toolPresentations, screen, editor.notice, {
      changed: () => { status?.refresh(); editor?.refresh() },
      evicted: ref => { operations?.closeChild(ref) },
      retainOnly: refs => { operations?.retainOnly(refs) },
      primaryVisible: visible => { conversation!.setVisible(visible) },
      reopen: (ref, facts) => {
        const client = app?.registry.get(ref.host)
        if (client === undefined || operations === undefined) return
        const generation = client.state.getSnapshot().generation
        const address = facts.address ?? client.sessions.subagentAddress(ref.sessionId)
        const opening = facts.kind === 'btw'
          ? operations.openBtw(client, ref, facts, lifetime.signal)
          : address === undefined ? Promise.reject(new Error('The native child address is unavailable'))
            : operations.openChild(client, address, lifetime.signal)
        void opening.catch((error: unknown) => {
          if (!lifetime.signal.aborted && app?.activeClient === client && client.state.getSnapshot().generation === generation) editor?.notice.set(error instanceof Error ? error.message : String(error))
        })
      },
    })
    panels = new RemotePanelController(screen, () => editor?.focus(), true, ctx.mayflyComponents)
    app = new RemoteApp(conversation, editor.notice, new RemotePlainPanels(ctx), undefined, options.cwd ?? process.cwd(), {
      open: (client, current, select) => { sessionsBrowser!.open(client, current, select) },
    }, () => {
      const selected = sideViews?.selected()
      return selected === undefined ? undefined : { ref: selected.ref, access: selected.facts.access, binding: selected.binding, presentation: displayedFacts() }
    }, () => commandSource?.list() ?? [], listener => sideViews!.subscribe(listener))
    apps.push(app)
    let primaryBinding = app.registry.currentReference?.binding
    ctx.effect(() => app!.subscribeTopology(() => {
      const next = app!.registry.currentReference?.binding
      if (next === primaryBinding) return
      primaryBinding = next
      for (const ref of sideViews!.references()) operations?.closeChild(ref)
    }))
    ctx.effect(() => ctx.mayflyUiImages.provide(async (attachmentId) => {
      const reference = sideViews!.current() === undefined ? conversation!.imageAttachment(attachmentId) : sideViews!.imageAttachment(attachmentId)
      if (reference === undefined) return undefined
      const data = await editorComposition!.controller.readAttachment({
        attachmentId: AttachmentId(reference.attachmentId),
        mediaType: reference.mediaType,
        bytes: reference.bytes,
        width: reference.width,
        height: reference.height,
        ...reference.name === undefined ? {} : { name: reference.name },
        ...reference.originalDimensions === undefined ? {} : { originalDimensions: { ...reference.originalDimensions } },
      })
      return data === undefined ? undefined : { data, mediaType: reference.mediaType }
    }))
    features = mountRemoteFeatures({
      ctx,
      screen,
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      overlays: panels,
      notice: editor.notice,
      startupPlan: app.startupPlan,
      hosts: {
        active: () => app!.activeClient,
        list: () => app!.registry.list(),
        current: displayedSelection,
        subscribe: listener => {
          const offApp = app!.subscribeTopology(listener)
          const offSide = sideViews!.subscribe(listener)
          return () => { offApp(); offSide() }
        },
      },
    })
    const featureContext = features.context
    sessionsBrowser = new RemoteSessionsBrowserController(featureContext, {
      home: client => client.remote.$host.home ?? '',
      directory: () => options.cwd ?? process.cwd(),
      openChild: async (client, address, signal) => { await operations!.openChild(client, address, signal) },
    })
    configuration = mountRemoteConfigurationComposition(featureContext, {
      clientVersion: remoteClientVersion(),
      edit: createRemoteSettingsEditor({ suspend: run => screen.suspend(run) }),
    })
    operations = mountRemoteOperationsComposition(featureContext, {
      localCwd: options.cwd ?? process.cwd(),
      btw: app.btw,
      present: (ref, binding, facts) => { sideViews!.present(binding, { ref, cwd: facts.cwd ?? '' }, facts) },
      closePresent: ref => { sideViews!.close(ref) },
      copy: (text) => editorComposition!.controller.copyText(text).then(() => undefined),
    })
    commandSource = mergeRemoteFeatureCommandSources(
      features.commands,
      configuration.commands,
      operations.commands,
    )
    editorComposition = mountEditorComposition({
      app,
      editor: editor.editor,
      screen,
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      keymap: ctx.mayflyKeymap,
      notice: editor.notice,
      localCwd: options.cwd ?? process.cwd(),
      exit: stop,
      featureCommands: commandSource,
      focusEditor: () => editor!.focus(),
      selection: displayedSelection,
      subscribeSelection: listener => sideViews!.subscribe(listener),
    })
    status = mountRemoteStatus(ctx, () => ({
      presentation: displayedFacts(),
      values: (sideViews!.sessionFacts() ?? conversation!.sessionFacts()).values,
      conversation: sideViews!.kind(),
    }), {
      home: () => app?.activeClient?.remote.$host.home ?? '',
      directory: () => options.cwd ?? process.cwd(),
    })
    await ctx.plugin({
      name: 'mayfly-remote-retained-renderers',
      inject: ['mayflyTheme', 'mayflyComponents'],
      apply(owner: Context) {
        editor!.retheme(owner.mayflyComponents, owner.mayflyTheme.colors)
        completionDrawer?.dispose()
        completionDrawer = mountRemoteCompletionDrawer(owner, screen, editor!.editor, owner.mayflyTheme.colors, owner.mayflyComponents)
        screen.requestRender()
      },
    })
    await app.attach(options.startupUrl, options.hostId)
    if (options.sessionId !== undefined) await app.selectOrCreate(options.sessionId, options.cwd)
    if (options.task !== undefined && options.task.trim() !== '') await execute(options.task)
    await done.promise
  } finally {
    lifetime.abort()
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
    operations?.dispose()
    sessionsBrowser?.dispose()
    configuration?.dispose()
    features?.dispose()
    sideViews?.dispose()
    editorComposition?.dispose()
    panels?.dispose()
    completionDrawer?.dispose()
    editor?.dispose()
    await status?.dispose()
    conversation?.dispose()
    transcript?.dispose()
    await toolPresentations?.dispose()
    const clients = apps.flatMap(app => app.registry.list())
    await Promise.allSettled(clients.map(client => apps[0]!.registry.detach(client.key)))
    await ctx.fiber.dispose()
  }
}

function sameRef(left: SessionRef | undefined, right: SessionRef): boolean {
  return left?.host === right.host && left.sessionId === right.sessionId
}

function selectedRef(ref: SessionRef | undefined): SessionRef {
  if (ref === undefined) throw new Error('The selected Session changed before the queue mutation')
  return ref
}
