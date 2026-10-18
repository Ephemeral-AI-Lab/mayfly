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
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter'
import type { MayflyDecisionRequest } from '../core/types.ts'
// Empty type import carries the app-owned session reader/projection services.
import type {} from '../app/index.ts'
import { copyTextToClipboard } from '../interaction/clipboard-write.ts'
import { openInEditor } from '../interaction/decision-actions.ts'
import { createInteractionNotificationOwner } from '../interaction/notifications.ts'
import { mountFocusModeStatus } from './status-focus.ts'
import { mountStatusFooter } from './status-rows.ts'
import { userMessageText } from './stream-facts.ts'
import { TranscriptController, type StreamRowActions } from './transcript-model.ts'
import { OfficialConversationModelSource } from './official-model.ts'
import type { LiveDraftSource } from './conversation-feed.ts'
import { ConversationSlots } from './conversation-slots.ts'
import type { SessionFactsService } from './session-facts.ts'
import type { SpawnedChild, SpawnedChildren } from './tool-calls.ts'
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
  let queued: readonly { readonly id: string, readonly text: string, readonly lane: 'turn' | 'step' }[] = []
  const readQueued = (): void => {
    queued = selected === null ? [] : [
      ...selected.inbox.nextStep.map(message => ({ message, lane: 'step' as const })),
      ...selected.inbox.nextTurn.map(message => ({ message, lane: 'turn' as const })),
    ].filter(({ message }) => message.source.kind === 'user')
      .map(({ message, lane }) => ({ id: String(message.id), text: userMessageText(message), lane }))
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
  // The row under the stream's cursor goes to the clipboard or to $EDITOR; the outcome is a notice on the notification pane.
  mountFocusModeStatus(ctx, t)
  const rowNotices = createInteractionNotificationOwner(ctx, 'mayfly.transcript.rows', 'transcript-rows')
  const rows: StreamRowActions = {
    copy: (text, mode) => {
      copyTextToClipboard(text).then(
        (method) => { rowNotices.report('copy', { message: t(mode === 'raw' ? (method === 'native' ? 'Copied {count} characters of JSON' : 'Copied {count} characters of JSON (unverified)') : (method === 'native' ? 'Copied {count} characters' : 'Copied {count} characters (unverified)'), { count: text.length }), severity: 'success' }) },
        (error: unknown) => { rowNotices.report('copy', { message: t('Could not copy'), severity: 'error', detail: error instanceof Error ? error.message : String(error) }) },
      )
    },
    open: (text) => {
      void openInEditor(ctx, text, t, new AbortController().signal).then((reply) => {
        if (reply.kind === 'failed') rowNotices.report('open', { message: reply.message, severity: 'error' })
      })
    },
    // The input editor holds the inbox restore data of the messages it queued, so it answers.
    queued: (action, id) => { ctx.emit('mayfly/queued-action', action, id) },
  }
  // The compaction rows read the selected Agent's occupancy marks; the stream is published again when a mark lands.
  const sessionFacts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  // The selected Session's native pressure supplies the compaction bar's window
  // and its unmarked occupancy; the presentation facts own only the marks.
  const readPressure = (): ContextPressureProjection | undefined => {
    const session = ctx.mayflyCurrentAgent.current()?.session
    return session === undefined ? undefined : ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure
  }
  let pressure = readPressure()
  // The requests waiting on the user, in the order they were asked: the plugins that put them to the user publish their
  // queues, and the stream turns the first one's call into the request block.
  const queues: Record<'approval' | 'plan', readonly MayflyDecisionRequest[]> = { approval: [], plan: [] }
  let requests: readonly MayflyDecisionRequest[] = []
  // The children the displayed conversation spawned: a spawn's line follows its child (running, settled, failed).
  let children: SpawnedChildren = { byId: new Map(), byPrompt: new Map() }
  const transcript: TranscriptController = new TranscriptController({ presentation, t, queued: () => queued, requests: () => requests, imageRefs, rows, focusMode: mode => ctx.emit('mayfly/focus-mode-changed', mode), focusRow: row => ctx.emit('mayfly/focus-row-changed', row), tick: ctx.mayflyTick, context: () => sessionFacts === undefined ? undefined : { marks: sessionFacts.current.compactions, ...pressure?.contextWindow === undefined ? {} : { window: pressure.contextWindow }, ...pressure === undefined ? {} : { tokens: pressure.projectedTokens ?? pressure.pressureTokens }, approvals: sessionFacts.current.approvals, children } })
  let marks = sessionFacts?.current.compactions
  let approvals = sessionFacts?.current.approvals
  const offMarks = sessionFacts?.subscribe((facts) => {
    if (facts.compactions === marks && facts.approvals === approvals) return
    marks = facts.compactions
    approvals = facts.approvals
    transcript.republish()
  })
  ctx.effect(() => () => offMarks?.())
  // Only the exact selected Session's pressure re-reads: a compaction reprices
  // the next request, a new request reports new usage, and a switch rebinds.
  const offPressure = ctx.sessionProjections.onChanged((session, key) => {
    if (key !== 'contextPressure' || session !== ctx.mayflyCurrentAgent.current()?.session) return
    pressure = readPressure()
    transcript.republish()
  })
  ctx.effect(() => () => offPressure())
  let childrenKey = ''
  const offChildren = sessionFacts?.subscribeChildren((list) => {
    const byId = new Map<string, SpawnedChild>()
    const byPrompt = new Map<string, SpawnedChild>()
    for (const child of list) {
      const spawned: SpawnedChild = child.phase === 'completed' || child.phase === 'failed'
        ? { state: 'settled', failed: child.phase === 'failed', ...child.stopped === true ? { stopped: true } : {}, ...child.endedAt === undefined ? {} : { endedAt: child.endedAt } }
        : { state: 'running' }
      byId.set(child.id, spawned)
      if (child.promptText !== undefined && !byPrompt.has(child.promptText)) byPrompt.set(child.promptText, spawned)
    }
    // Only a change of state republishes: the streamed counters of a running child are the item's, not the stream's.
    const key = JSON.stringify([...byId])
    if (key === childrenKey) return
    childrenKey = key
    children = { byId, byPrompt }
    transcript.republish()
  })
  ctx.effect(() => () => offChildren?.())
  ctx.effect(() => ctx.on('mayfly/decision-requests-changed', (source, next) => {
    queues[source] = next
    requests = [...queues.approval, ...queues.plan]
    transcript.republish()
  }))
  ctx.effect(() => () => transcript.dispose())
  // Every displayed or retained conversation reads its own native path; the
  // registry decides which views exist, the controller which one is mounted.
  const slots = new ConversationSlots(ctx, transcript, {
    source: (agent, publish, counters) => new OfficialConversationModelSource(
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
      counters,
    ),
    headed: { liveTurnHeader: true },
    history: () => ctx.get('sessionController'),
  })
  ctx.effect(() => () => slots.dispose())
  // A spawn/dispose burst emits once per changed tool; one microtask marks
  // every retained view stale, and the controller republishes the displayed one.
  let toolsChangePending = false
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    toolsChangePending = false
  })
  ctx.on('tools/change', () => {
    if (disposed || toolsChangePending) return
    toolsChangePending = true
    queueMicrotask(() => {
      toolsChangePending = false
      if (!disposed) slots.invalidateTools()
    })
  })
  const sync = (): void => { slots.sync(ctx.mayflyConversations.snapshot()) }
  // A same-id Agent replacement changes the exact Agent without a registry change.
  const offView = ctx.mayflyConversations.subscribe(sync)
  const offAgent = ctx.mayflyCurrentAgent.subscribe((agent) => {
    selected = agent
    readQueued()
    pressure = readPressure()
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
  ctx.effect(() => ctx.on('mayfly/request-new-messages', () => { transcript.jumpNew() }))
  transcript.attach(screen)
  // The footer is the two status rows on the footer node slot; the slot pins to the dock's lowest row (S12), so the
  // status stays on the terminal's last rows beneath the editor, and the status row is only there while it has an entry.
  mountStatusFooter(ctx, screen)

  let offKeymap: () => void = () => {}
  const registerKeymap = (): void => {
    offKeymap()
    offKeymap = ctx.mayflyKeymap.register([{
      id: ACTION_TOGGLE_COLLAPSE,
      keys: 'ctrl+o',
      description: t('Toggle detail expansion (tool output, long messages)'),
      handler: () => {
        transcript.toggleRecent()
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
