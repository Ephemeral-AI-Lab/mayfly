import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import * as Core from '@ephemeral-ai/mayfly/core'
import * as ThemeDark from '@ephemeral-ai/mayfly/theme-dark'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { TranscriptController, type TranscriptControllerOptions } from '@ephemeral-ai/mayfly/transcript'

type QueueAction = Parameters<NonNullable<TranscriptControllerOptions['rows']>['queued']>[0]
import type { SessionRef } from '../client/types.ts'
import { RemoteToolPresentationCache } from '../frontend/tool-presentations.ts'
import { RemoteConversationModelSource } from '../transcript/remote-model.ts'
import { RemoteApp } from './app.ts'
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
import { RemoteStatusComponent } from './status.ts'

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
  let cancelled: { readonly ref: SessionRef, readonly text: string, readonly lane: 'turn' | 'step', readonly at: number } | undefined
  let stopped = false
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
    const screen = ctx.mayflyScreen
    let app: RemoteApp | undefined
    toolPresentations = new RemoteToolPresentationCache(ref => resolveMayflyToolPresentation(() => app?.registry.list() ?? [], ref))
    conversation = new RemoteConversationModelSource(toolPresentations, () => transcript?.refresh(), {
      onPresentation: () => screen.requestRender(),
      onCommandResult: (result) => {
        if (result.text !== undefined) editor?.notice.set(result.text)
      },
    })
    const bannerSlot = screen.mountContentSlot('transcript.prelude', new RemoteBannerComponent(
      ctx.mayflyTheme.colors,
      ctx.mayflyComponents,
      () => conversation!.presentation(),
    ))
    ctx.effect(() => () => bannerSlot.dispose())
    const imageRefs = new Map<string, { readonly attachmentId: string, readonly mediaType: string }>()
    const queueAction = async (action: QueueAction, id: string | undefined): Promise<void> => {
      const controller = editorComposition?.controller
      if (controller === undefined) return
      const current = conversation!.presentation()
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
    transcript = new TranscriptController({
      t: Frontend.interpolateLocaleMessage,
      queued: () => conversation!.presentation().queue,
      tick: ctx.mayflyTick,
      context: () => ({
        window: conversation!.presentation().contextWindow,
        tokens: conversation!.presentation().contextTokens,
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
    })
    completionDrawer = mountRemoteCompletionDrawer(screen, editor.editor, ctx.mayflyTheme.colors, ctx.mayflyComponents)
    sideViews = new RemoteSideViews(transcript, toolPresentations, screen, editor.notice)
    panels = new RemotePanelController(screen, () => editor?.focus(), true, ctx.mayflyComponents)
    app = new RemoteApp(conversation, editor.notice, new RemotePlainPanels(panels, ctx.mayflyComponents, ctx.mayflyTheme.colors))
    apps.push(app)
    ctx.effect(() => ctx.mayflyUiImages.provide(async (attachmentId) => {
      const reference = conversation!.imageAttachment(attachmentId)
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
      hosts: {
        list: () => app!.registry.list(),
        current: () => {
          const ref = app!.registry.current
          const reference = app!.registry.currentReference
          if (ref === undefined || reference === undefined) return undefined
          const client = app!.registry.get(ref.host)
          if (client === undefined) return undefined
          return { ref, client, binding: reference.binding }
        },
        subscribe: listener => app!.subscribeTopology(listener),
      },
    })
    const featureContext = features.context
    configuration = mountRemoteConfigurationComposition(featureContext, {
      clientVersion: remoteClientVersion(),
    })
    operations = mountRemoteOperationsComposition(featureContext, {
      localCwd: options.cwd ?? process.cwd(),
      btw: app.btw,
      present: (ref, binding) => { sideViews!.present(binding, { ref, cwd: '' }) },
      closePresent: () => { sideViews!.close() },
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
    })
    const statusSlot = screen.mountDockSlot('status.footer', new RemoteStatusComponent(
      ctx.mayflyComponents,
      ctx.mayflyTheme.colors,
      () => conversation!.presentation(),
    ), 'bottom')
    ctx.effect(() => () => statusSlot.dispose())
    await app.attach(options.startupUrl, options.hostId)
    await app.selectOrCreate(options.sessionId, options.cwd)
    if (options.task !== undefined && options.task.trim() !== '') await execute(options.task)
    await done.promise
  } finally {
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
    operations?.dispose()
    configuration?.dispose()
    features?.dispose()
    sideViews?.dispose()
    editorComposition?.dispose()
    panels?.dispose()
    completionDrawer?.dispose()
    editor?.dispose()
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
