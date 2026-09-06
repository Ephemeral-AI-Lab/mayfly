/**
 * Full-fidelity read-only transcript fallback for one-shot or cold subagents.
 * Live auxiliary Agents use the ordinary application layout instead.
 *
 * @module @ephemeral-ai/mayfly/interaction/session-transcript-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { MayflyFocusable } from '../core/index.ts'
import { ScrollablePanel } from '../core/scrollable-panel.ts'
import { conversationProjectionSchema } from '../conversation/index.ts'
import type { MayflyAuxiliaryView } from '../app/current-agent.ts'
import {
  conversationTranscriptModel,
  OfficialConversationModelSource,
} from '../transcript/official-model.ts'
import {
  createTranscriptModel,
  TranscriptModelComponent,
  type TranscriptModelRenderer,
} from '../transcript/transcript-model.ts'
import type { ToolPresentationSource } from '../transcript/present.ts'
import type { TranscriptModel } from '../frontend/index.ts'
import { mountEditorReplacement } from './editor-panel-controller.ts'
import { ACTION_CANCEL, ACTION_CLOSE_AGENT_VIEW, ACTION_TOGGLE_AGENT_VIEW, interactionKeyHint } from './keys.ts'

type SubagentView = Extract<MayflyAuxiliaryView, { readonly kind: 'subagent' }>

/** One retained readonly viewer and its live/cold projection resources. */
export class SessionTranscriptPanel implements MayflyFocusable {
  private model: TranscriptModel = createTranscriptModel('readonly-subagent', [
    { kind: 'loader', message: 'loading conversation...', variant: 'braille' },
  ], false, 1)
  private generation = 1
  private disposed = false
  private readonly abort = new AbortController()
  private readonly source: OfficialConversationModelSource
  private readonly body: TranscriptModelComponent
  private readonly shell: ScrollablePanel

  constructor(
    private readonly ctx: Context,
    readonly target: SubagentView,
    onClose: () => void,
  ) {
    const screen = ctx.mayflyScreen
    const childAgent = ctx.agents.get(SessionId(target.sessionId))
    const live = childAgent?.session ?? [...ctx.sessions.list()].find(session => String(session.id) === target.sessionId)
    const tools: ToolPresentationSource = { get: name => ctx.tools.get(name, childAgent) }
    const renderer: TranscriptModelRenderer = {
      colors: ctx.mayflyTheme.colors,
      components: ctx.mayflyComponents,
      images: () => {
        const attachments = ctx.get('attachments') as { readImage(ref: unknown): Promise<{ data: Uint8Array }> } | undefined
        return attachments === undefined ? {} : {
          loadImage: async ref => (await attachments.readImage(ref)).data,
          onReady: () => screen.requestRender(),
        }
      },
      requestRender: () => screen.requestRender(),
    }
    this.body = new TranscriptModelComponent(
      live === undefined ? () => this.model : () => this.source.snapshot(),
      renderer,
    )
    this.shell = new ScrollablePanel({
      screen,
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      body: this.body,
      title: () => `Subagent · ${target.label}`,
      hint: () => `${target.mode} · read-only`,
      footer: () => [
        `${interactionKeyHint(ctx.mayflyKeymap, ACTION_TOGGLE_AGENT_VIEW, 'F7')} toggle · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_CLOSE_AGENT_VIEW, 'F8')} close · ${interactionKeyHint(ctx.mayflyKeymap, ACTION_CANCEL, 'Esc')} close`,
      ],
      onClose,
    })
    this.source = new OfficialConversationModelSource(
      ctx.sessionProjections,
      tools,
      () => screen.requestRender(),
    )
    if (live === undefined) void this.loadCold(tools)
    else this.source.attach(live)
  }

  get focused(): boolean { return this.shell.focused }
  set focused(value: boolean) { this.shell.focused = value }

  handleInput(data: string): void { this.shell.handleInput(data) }
  invalidate(): void { this.shell.invalidate() }
  render(width: number): string[] { return this.shell.render(width) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.source.dispose()
    this.shell.dispose()
  }

  private async loadCold(tools: ToolPresentationSource): Promise<void> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      this.fail('the subagent session is not live and no session query service is available')
      return
    }
    try {
      const observation = await query.observeSession(SessionId(this.target.sessionId), {
        projectionMode: 'all',
        signal: this.abort.signal,
      })
      try {
        if (this.disposed) return
        const parsed = conversationProjectionSchema.safeParse(observation.projections?.values['mayflyConversation'])
        if (!parsed.success) {
          this.fail('the stored subagent conversation is unavailable')
          return
        }
        this.generation += 1
        this.model = conversationTranscriptModel(parsed.data, tools, this.generation)
        this.shell.invalidate()
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error) {
      if (this.disposed) return
      this.fail(`could not read the subagent conversation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private fail(message: string): void {
    this.generation += 1
    this.model = createTranscriptModel('readonly-subagent', [
      { kind: 'empty', title: 'conversation unavailable', description: message },
    ], false, this.generation)
    this.shell.invalidate()
  }
}

/** Stable child-plugin name. */
export const name = 'mayfly-session-transcript-panel'
/** Renderer, projection, and editor-slot services required by the fallback. */
export const inject = ['mayflyCurrentAgent', 'mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyKeymap', 'mayflyEditorPanels', 'sessionProjections', 'sessions', 'tools', 'agents']

/** Mount the retained readonly auxiliary when it is the displayed view. */
export function apply(ctx: Context): void {
  let retained: { readonly target: SubagentView, readonly panel: SessionTranscriptPanel, restore: (() => void) | undefined } | undefined

  const clear = (): void => {
    const current = retained
    retained = undefined
    current?.restore?.()
    current?.panel.dispose()
  }
  const sync = (): void => {
    const snapshot = ctx.mayflyCurrentAgent.view()
    const target = snapshot.auxiliary
    if (target?.kind !== 'subagent' || target.access !== 'readonly') {
      clear()
      return
    }
    if (retained?.target.sessionId !== target.sessionId) {
      clear()
      const admitted: SubagentView = {
        kind: 'subagent',
        sessionId: target.sessionId,
        parentSessionId: target.parentSessionId,
        label: target.label,
        mode: target.mode,
      }
      retained = {
        target: admitted,
        panel: new SessionTranscriptPanel(ctx, admitted, () => { ctx.emit('mayfly/request-close-agent-view') }),
        restore: undefined,
      }
    }
    if (snapshot.displayed === 'auxiliary' && retained.restore === undefined) {
      retained.restore = mountEditorReplacement(ctx, retained.panel)
    } else if (snapshot.displayed === 'primary' && retained.restore !== undefined) {
      retained.restore()
      retained.restore = undefined
    }
  }

  const offView = ctx.mayflyCurrentAgent.subscribeView(sync)
  ctx.effect(() => offView)
  ctx.effect(() => clear)
}
