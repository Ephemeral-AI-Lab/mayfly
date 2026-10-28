import { Context } from '@deepseek-ai/cordis'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import * as Core from '@ephemeral-ai/mayfly/core'
import * as ThemeDark from '@ephemeral-ai/mayfly/theme-dark'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import { TranscriptController } from '@ephemeral-ai/mayfly/transcript'
import { RemoteConversationModelSource } from '../transcript/remote-model.ts'
import { RemoteApp } from './app.ts'
import { RemoteBannerComponent } from './banner.ts'
import { mountRemoteEditor, type RemoteEditorHandle } from './editor.ts'
import { RemotePanelController } from './panels.ts'
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
  let panels: RemotePanelController | undefined
  let conversation: RemoteConversationModelSource | undefined
  let transcript: TranscriptController | undefined
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
    conversation = new RemoteConversationModelSource({ get: () => undefined }, () => transcript?.refresh(), {
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
    transcript = new TranscriptController({
      t: Frontend.interpolateLocaleMessage,
      queued: () => [],
    })
    transcript.setView('remote', () => conversation!.snapshot())
    transcript.show('remote')
    transcript.attach(screen)
    let app: RemoteApp | undefined
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
    panels = new RemotePanelController(screen, ctx.mayflyComponents, ctx.mayflyTheme.colors, () => editor?.focus())
    app = new RemoteApp(conversation, editor.notice, panels)
    apps.push(app)
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
    panels?.dispose()
    editor?.dispose()
    conversation?.dispose()
    transcript?.dispose()
    const clients = apps.flatMap(app => app.registry.list())
    await Promise.allSettled(clients.map(client => apps[0]!.registry.detach(client.key)))
    await ctx.fiber.dispose()
  }
}
