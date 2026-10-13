/**
 * @ephemeral-ai/mayfly/transcript — terminal transcript surfaces for the frontend runtime.
 * The official conversation plugin publishes a renderer-neutral transcript
 * model from the Harness projection; this plugin maps the displayed model to
 * the stream's facts and publishes the stream into the conversation node slot,
 * keeps one view per displayed or retained conversation, and owns Ctrl-O
 * expansion, settings, dock chrome, and the canonical status footer. It does
 * not fold a Harness event log. Unloading removes the slot, mounted components,
 * and keymap actions.
 *
 * @module @ephemeral-ai/mayfly/transcript
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GutterComponent } from '../core/gutter.ts'
import type { MayflyDecisionRequest } from '../core/types.ts'
// Empty type import carries the app-owned session reader/projection services.
import type {} from '../app/index.ts'
import { StatusFooterComponent } from './status-model.ts'
import { userMessageText } from './stream-facts.ts'
import { TranscriptController } from './transcript-model.ts'
import { OfficialConversationModelSource } from './official-model.ts'
import type { LiveDraftSource } from './conversation-feed.ts'
import { ConversationSlots } from './conversation-slots.ts'
import type { SessionFactsService } from './session-facts.ts'
import {
  DEFAULT_EXPAND_TURNS,
  followPresentationSettings,
  TranscriptPresentationPolicy,
} from './presentation-policy.ts'
import {
  mountTranscriptLocale,
  observeTranscriptLocale,
  TRANSCRIPT_LOCALE,
  transcriptTranslator,
} from './locale.ts'

export { READ_PREVIEW_LINE_LIMIT, SEARCH_PREVIEW_MATCH_LIMIT, SEARCH_PATH_LIMIT, COMMAND_PREVIEW_LINE_LIMIT } from './official-model.ts'
export { conversationTranscriptModel } from './official-model.ts'
export type { ToolPresentationSource } from './present.ts'
export { parseXmlEnvelope, summarizeToolText, type EnvelopePair } from './envelope.ts'
export { ellipsize, parseToolArguments, summarizeToolCall, TOOL_ARG_PAIR_LIMIT, TOOL_ARG_VALUE_MAX_CHARS } from './present.ts'
export { SessionFactsService } from './session-facts.ts'
export { createToolPresentationModel, toolCallNode, toolResultNode } from './tool-model.ts'
export type { ToolPresentationFacts } from './tool-model.ts'
export { appendTranscriptNode, createTranscriptModel, TranscriptController } from './transcript-model.ts'
export type { TranscriptControllerOptions, TranscriptViewOptions } from './transcript-model.ts'
export type {
  TranscriptAssistantItem,
  TranscriptItem,
  TranscriptThinkingItem,
  TranscriptToolItem,
  TranscriptToolResult,
  TranscriptUserItem,
} from './types.ts'
export {
  DEFAULT_EXPAND_TURNS,
  DEFAULT_TRANSCRIPT_PRESENTATION,
  DEFAULT_USER_FOLD_CHARS,
  DEFAULT_USER_FOLD_LINES,
  DEFAULT_WINDOW_TURNS,
  PROCESS_POLICIES,
  TranscriptPresentationPolicy,
} from './presentation-policy.ts'
export type { ProcessPolicy, TranscriptPresentationSnapshot, TranscriptViewMode } from './presentation-policy.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-transcript'

/** Services the plugin requires before it can mount. */
export const inject = ['mayflyConversationReady', 'mayflyLiveAssistantStream', 'mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyKeymap', 'mayflyStatus', 'mayflyTick', 'mayflyConversations', 'mayflyCurrentAgent', 'agents', 'sessionProjections', 'sessions', 'tools']

/** The global action toggling tool-output expansion (Ctrl-O). */
export const ACTION_TOGGLE_COLLAPSE = 'mayfly.transcript.toggle-collapse'

/**
 * The Ctrl-O expansion range (kimi `TRANSCRIPT_EXPAND_TURNS`): only cards in
 * the most recent turns flip; older turns stay collapsed.
 */
export const EXPAND_TURNS = DEFAULT_EXPAND_TURNS

/** The plugin-wide expansion state forwarded to the semantic transcript model. */
interface CollapseToggle { expanded: boolean }
/**
 * Mount the transcript components and model footer. The official transcript
 * consumer owns projection binding; this fiber provides the single
 * conversation controller, dock chrome, settings, and global Ctrl-O expansion action.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  mountTranscriptLocale(ctx, 'transcript', TRANSCRIPT_LOCALE)
  const t = transcriptTranslator(ctx, 'transcript')
  const screen = ctx.mayflyScreen
  const colors = ctx.mayflyTheme.colors
  const toggle: CollapseToggle = { expanded: false }
  const presentation = new TranscriptPresentationPolicy()
  // Mayfly settings ride the host settings document: the resolved `mayfly`
  // namespace (schema owned by interaction) carries the work-details mode
  // (`transcriptView`) and the transcript tunables (`windowTurns` /
  // `expandTurns` / `userFoldLines` / `userFoldChars`). The service is optional and its
  // value unknown here, so every read parses defensively — absent keys or
  // wrongly typed values keep the current setting; a host without settings
  // keeps every shipped default.
  followPresentationSettings(ctx, presentation, () => transcript.refreshPresentationPolicy())

  // Frontend owns live drafts across renderer/theme reloads.
  const liveStream = ctx.mayflyLiveAssistantStream
  const liveDrafts: LiveDraftSource = {
    subscribe: listener => liveStream.subscribe(listener),
    get: agent => liveStream.get(agent),
  }
  // The messages typed while the agent works are the inbox of the selected Agent. The inbox is read when it changes (as
  // the queue pane does), never while a model is being published: a read inside a session event disturbs the
  // activity row's own bookkeeping of that event.
  let selected: Agent | null = null
  let queued: readonly { readonly id: string, readonly text: string }[] = []
  const readQueued = (): void => {
    queued = selected === null ? [] : [...selected.inbox.nextStep, ...selected.inbox.nextTurn]
      .filter(message => message.source.kind === 'user')
      .map(message => ({ id: String(message.id), text: userMessageText(message) }))
  }
  // The wire carries an attachment id; the byte loader resolves it through the attachment store with the reference the
  // stream kept when it built the prompt's row. A missing store or file leaves the text fallback.
  const imageRefs = new Map<string, { readonly attachmentId: string, readonly mediaType: string }>()
  ctx.effect(() => (ctx.get('mayflyUiImages')?.provide(async (attachmentId) => {
    const ref = imageRefs.get(attachmentId)
    const attachments = ctx.get('attachments') as { readImage(ref: unknown): Promise<{ readonly data: Uint8Array }> } | undefined
    if (ref === undefined || attachments === undefined) return undefined
    try {
      return { data: (await attachments.readImage(ref)).data, mediaType: ref.mediaType }
    } catch {
      return undefined
    }
  }) ?? (() => {})))
  // The compaction rows read the selected Agent's occupancy marks; the stream is published again when a mark lands.
  const sessionFacts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  // The requests waiting on the user, in the order they were asked: the plugins that put them to the user publish their
  // queues, and the stream turns the first one's call into the request block.
  const queues: Record<'approval' | 'plan', readonly MayflyDecisionRequest[]> = { approval: [], plan: [] }
  let requests: readonly MayflyDecisionRequest[] = []
  const transcript: TranscriptController = new TranscriptController({ presentation, t, queued: () => queued, requests: () => requests, imageRefs, tick: ctx.mayflyTick, context: () => sessionFacts === undefined ? undefined : { marks: sessionFacts.current.compactions, window: sessionFacts.current.contextWindow, tokens: sessionFacts.current.contextTokens, approvals: sessionFacts.current.approvals } })
  let marks = sessionFacts?.current.compactions
  let window = sessionFacts?.current.contextWindow
  let approvals = sessionFacts?.current.approvals
  const offMarks = sessionFacts?.subscribe((facts) => {
    if (facts.compactions === marks && facts.contextWindow === window && facts.approvals === approvals) return
    marks = facts.compactions
    window = facts.contextWindow
    approvals = facts.approvals
    transcript.republish()
  })
  ctx.effect(() => () => offMarks?.())
  ctx.effect(() => ctx.on('mayfly/decision-requests-changed', (source, next) => {
    queues[source] = next
    requests = [...queues.approval, ...queues.plan]
    transcript.republish()
  }))
  ctx.effect(() => () => transcript.dispose())
  // Every displayed or retained conversation reads its own native path; the
  // registry decides which views exist, the controller which one is mounted.
  const slots = new ConversationSlots(ctx, transcript, {
    source: (agent, publish) => new OfficialConversationModelSource(
      ctx.sessionProjections,
      { get: toolName => {
        const definition = ctx.tools.get(toolName, agent)
        if (definition === undefined) return undefined
        return {
          ...(definition.presentCall === undefined ? {} : { presentCall: definition.presentCall }),
          ...(definition.presentResult === undefined ? {} : { presentResult: definition.presentResult }),
        }
      } },
      publish,
      liveDrafts,
      t,
    ),
    headed: { liveTurnHeader: true },
    history: () => ctx.get('sessionController'),
  })
  ctx.effect(() => () => slots.dispose())
  ctx.on('tools/change', () => slots.invalidateTools())
  const sync = (): void => { slots.sync(ctx.mayflyConversations.snapshot()) }
  // A same-id Agent replacement changes the exact Agent without a registry change.
  const offView = ctx.mayflyConversations.subscribe(sync)
  const offAgent = ctx.mayflyCurrentAgent.subscribe((agent) => {
    selected = agent
    readQueued()
    sync()
    transcript.republish()
  })
  ctx.effect(() => () => offView())
  ctx.effect(() => () => offAgent())
  // A message enters or leaves the selected Agent's inbox: the queued rows follow it.
  const onInbox = ({ agent }: { readonly agent: unknown }): void => {
    if (agent !== selected) return
    readQueued()
    transcript.republish()
  }
  for (const off of [ctx.on('agent/inbox/inserted', onInbox), ctx.on('agent/inbox/claimed', onInbox), ctx.on('agent/inbox/discarded', onInbox)]) ctx.effect(() => () => off())
  const footer = new StatusFooterComponent(
    ctx.mayflyStatus,
    ctx.mayflyComponents,
    colors,
    () => ({ columns: screen.columns, rows: screen.rows }),
    screen.views,
  )
  const offStatus = ctx.mayflyStatus.subscribe(() => {
    footer.invalidate()
    screen.requestRender()
  })
  ctx.effect(() => offStatus)
  transcript.attach(screen)
  // The footer pins to the dock's lowest slot (S12): the status row stays
  // on the terminal's last row beneath the editor, the kimi layout dialog
  // panels pull up over.
  ctx.effect(() => {
    const slot = screen.mountDockSlot('status.footer', new GutterComponent(footer), 'bottom')
    return () => slot.dispose()
  })

  let offKeymap: () => void = () => {}
  const registerKeymap = (): void => {
    offKeymap()
    offKeymap = ctx.mayflyKeymap.register([{
      id: ACTION_TOGGLE_COLLAPSE,
      keys: 'ctrl+o',
      description: t('Toggle detail expansion (tool output, long messages)'),
      handler: () => {
        toggle.expanded = !toggle.expanded
        transcript.setExpanded(toggle.expanded)
        screen.requestRender(true)
      },
    }])
  }
  registerKeymap()
  ctx.effect(() => () => offKeymap())

  const offLocale = observeTranscriptLocale(ctx, () => {
    transcript.refreshLocale()
    registerKeymap()
  })
  ctx.effect(() => offLocale)

}
