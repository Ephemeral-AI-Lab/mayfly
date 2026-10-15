/**
 * `mayfly-input` plugin: the bottom input editor, backed by the pi-tui Editor
 * through `ctx.mayflyComponents.createEditor` (multi-line, kill-ring, undo,
 * history, and paste markers are the component's own). The editor's frame
 * is the `Editor` component (`../components/editor.ts`): a rounded surface
 * with the conversation title in its top-right corner around the prompt,
 * whose buffer is this editor's own; shell mode shows as the `!` symbol and
 * the accent border. Submit
 * dispatches a slash command through `ctx.commands` when the line parses as
 * one, otherwise queues the text as a user follow-up message on the current
 * agent (the harness inbox queues it when the agent is running). S29: the
 * follow-up and Ctrl-S steer paths rewrite `#name` tokens naming settled
 * user-invocable skills into the `/name` harness gesture form (the
 * `./skills-catalog.ts` rewrite — line-start slashes stay a strict command
 * domain; skills reach the model through the follow-up channel, and the
 * editor history keeps the `#name` the user typed), and the fiber keeps the
 * skills catalog attached for the `#` completion branch. A hint
 * line below the editor carries the transient tiers — one-shot notices and
 * slash-command discovery in `muted` (S14: fuzzy-matched through the same
 * `./slash-filter.ts` the dropdown uses) — and renders zero rows
 * otherwise (the S15 dogfood verdict retired the persistent
 * key-affordance row: kimi teaches affordances through the footer's
 * rotating tips instead, and the tips pool already covers every fragment
 * the row carried). The editor-context key chain (Escape
 * interrupts a running session flow — safe retraction first when the buffer
 * is empty and eligible — and clears an idle draft; Ctrl-C empties the box
 * while a flow runs, interrupts with an empty buffer, and owns the idle
 * double-press-exit chain; Ctrl-S steer, Ctrl-G external
 * editor) resolves through
 * `ctx.mayflyKeymap` in the editor's `onKey` hook, which runs before the
 * pi-tui Editor sees the sequence. The mounted editor and the submit router
 * are published through
 * `./editor-instance.ts` so `mayfly-editor-plus` can layer input modes and
 * autocomplete over the same component. Pending messages are rows of
 * the conversation stream; its `e`, `s`, `d`, and `u` keys reach this editor as `mayfly/queued-action`. Live side
 * conversations use this same editor and transcript; delivery scope follows
 * the app-owned displayed conversation instead of a pane-specific input path. The
 * unsubmitted draft is mirrored
 * into `./draft-stash.ts`, so a theme-swap reload (the theme provider fiber
 * disposes, Cordis re-runs this `mayflyTheme` dependent) restores the text
 * into the freshly mounted editor. The same reload can land while a slash
 * command is still in flight — `/theme` disposes the theme provider between
 * `execute()` and its continuation — so the submit continuation gates on
 * the fiber's unload flag before touching the hint; a late notice is moot
 * anyway, since the reloaded fiber repaints. Command result notices are
 * flattened to one display row before truncation: an upstream command can
 * return multi-line status text, but embedded line breaks must never escape
 * the screen's one-string-per-terminal-row contract.
 *
 * @module @ephemeral-ai/mayfly/interaction/input-plugin
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyEditorToken, MayflyQueuedAction, MayflyScreen, MayflySubmittedDraft } from '../core/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ui, type MayflyFeedback, type MayflyUiNode, type MayflyUiScope } from '@ephemeral-ai/mayfly-ui'
import { Editor } from '../components/editor.ts'
import { CompletionDrawer } from '../core/completion-drawer.ts'
import { normalizeWheelInput } from '../core/terminal.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { PromptContentPart, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
// Carries the app-owned retraction service and event/service declaration merges.
import type {} from '../app/index.ts'
import type {} from './subagent-reply.ts'
import { interruptAgent, isAgentRunning } from '../app/agent-interrupt.ts'
// Empty type import carries the `permissionPresets` Context merge the
// bare-/permission interception probes (the service rides dsh-base).
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '../transcript/index.ts'
import {
  clearSharedEditor,
  setSharedEditor,
} from './editor-instance.ts'
import { applyReversibleSubmitTransformers } from './prompt-submit-pipeline.ts'
import { EditorExtensionRuntime } from './editor-extension-runtime.ts'
import { imageMarker } from './image-marker.ts'
import { displayPath } from '../internal/paths.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { createTokenSource, mentionFile } from './token-source.ts'
import { mountEditorPlus, sessionCwd } from './editor-plus.ts'
import { openFileInExternalEditor, resolveExternalEditorCommand, runExternalEditor } from './external-editor.ts'
import { currentMayflySettings } from './settings.ts'
import {
  ACTION_BACKSPACE,
  ACTION_CANCEL,
  ACTION_CYCLE_MODE,
  ACTION_CYCLE_MODEL,
  ACTION_EXTERNAL_EDITOR,
  ACTION_END,
  ACTION_FOLLOW_TAIL,
  ACTION_INTERRUPT,
  ACTION_MOVE_DOWN,
  ACTION_MOVE_UP,
  ACTION_PAGE_DOWN,
  ACTION_PAGE_UP,
  ACTION_FOCUS_NEXT,
  ACTION_FOCUS_PREV,
  ACTION_STEER,
  ACTION_SUBMIT,
} from './keys.ts'
import { interactionTranslator } from './locale.ts'
import { createModelListCache, cycleSessionModel } from './model-commands.ts'
import { cycleMode } from './mode-commands.ts'
import { openPermissionPanel } from './permission-panel.ts'
import { rewriteSkillTokens } from './skills-catalog.ts'
import { filterSlashCommands } from './slash-filter.ts'

/** Window for the double Ctrl-C exit: presses farther apart re-arm the hint. */
const INTERRUPT_DOUBLE_PRESS_MS = 1000

/**
 * Bare-command UI routes: a no-argument line may open a surface instead of
 * dispatching to the registered handler (the S24b/D33 `/permission` preset
 * picker). A route returning `false` falls through to `ctx.commands.execute`
 * untouched, keeping the upstream argument path.
 */
const BARE_COMMAND_ROUTES: Readonly<Record<string, (ctx: Context) => boolean>> = {
  permission: ctx => {
    if (ctx.get('permissionPresets') === undefined) return false
    openPermissionPanel(ctx)
    return true
  },
}

/** Commands whose result text never flashes the footer — the command's own UX already carries it. */
const QUIET_COMMANDS: ReadonlySet<string> = new Set(['goal'])

/** Per-message restore data kept while a submission waits in the inbox. */
interface QueuedDraft {
  readonly buffer?: MayflySubmittedDraft
  readonly historyText?: string
  readonly rollback?: () => void
}

interface AttachmentReader {
  readImage(ref: Extract<ContentBlock, { readonly type: 'image' }>['attachment'], signal?: AbortSignal): Promise<StoredImageAttachment>
}

/** The tallest an image preview paints, the shortest it is worth, and the rows the frame around it takes (rules, button, hint). */
const IMAGE_PREVIEW_ROWS = 40
const IMAGE_PREVIEW_MIN_ROWS = 4
const IMAGE_PREVIEW_CHROME_ROWS = 6

/** Convert admitted editor blocks back to the public subagent prompt wire. */
async function subagentPromptParts(attachments: AttachmentReader | undefined, blocks: readonly ContentBlock[], signal: AbortSignal): Promise<PromptContentPart[]> {
  const parts: PromptContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') throw new Error(`unsupported human prompt block: ${block.type}`)
    if (attachments === undefined) throw new Error('image delivery requires the attachment store')
    const stored = await attachments.readImage(block.attachment, signal)
    parts.push({
      type: 'image',
      mediaType: stored.ref.mediaType,
      data: Buffer.from(stored.data).toString('base64'),
      ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
    })
  }
  return parts
}

/** Command descriptors projected through the app-owned session boundary. */
function availableCommands(ctx: Context, agent: Agent) {
  return ctx.commands.list(agent).map(command => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint === undefined ? {} : { input: { hint: command.input.hint } }),
  }))
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-input'
/** Services required before the editor can mount. */
export const inject = ['mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyKeymap', 'mayflyPromptEditor', 'mayflyPromptSubmissions', 'mayflyUiInteraction', 'mayflyOverlays', 'commands', 'sessionProjections', 'agents', 'subagents', 'mayflyConversations', 'mayflyCurrentAgent', 'mayflyRequests', 'mayflyRetractions', 'mayflySkillsCatalog', 'mayflyInteractionState', 'mayflyEditorExtensions']

/**
 * Mount the input editor with the hint line pinned below it and focus the
 * editor; both revert when the plugin's fiber unloads.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const screen = ctx.mayflyScreen
  const conversations = ctx.mayflyConversations
  const requests = ctx.mayflyRequests
  const subagents = ctx.subagents
  const aliases = ctx.mayflyInteractionState.aliases
  const draft = ctx.mayflyInteractionState.draft
  const modelListCache = createModelListCache()
  /** Current editor text, captured through `onChange` for the slash hint. */
  let currentText = ''
  /**
   * Whether an external-editor session (Ctrl-G, S31) currently owns the
   * terminal through `mayflyScreen.suspend`. The flag refuses a second
   * Ctrl-G while one is in flight; it is fiber-scoped so a reload starts
   * fresh.
   */
  let externalEditorRunning = false
  /** Timestamp of the last idle Ctrl-C press; 0 means the exit is not armed. */
  let lastInterruptAt = 0
  /** The latest ordinary follow-up eligible to become an editor draft again. */
  let retractionCandidate: {
    readonly messageId: string
    readonly editorText: string
    readonly historyText: string
    readonly submitted?: MayflySubmittedDraft
    readonly rollback?: () => void
  } | undefined
  /**
   * Per-message restore data for inbox-pending submissions, keyed by message
   * id: the captured buffer (raw marker text plus its paste table) and the
   * submit transformer's rollback. A withdrawal reproduces exactly what the
   * editor showed; entries drop when the message leaves the inbox or the
   * session switches.
   */
  const queuedDrafts = new Map<string, QueuedDraft>()
  /**
   * Set when this fiber unloads: a submitted command can dispose it while
   * `execute()` is still in flight (`/theme` swaps the provider, reloading
   * every `mayflyTheme` dependent), and the late continuation must not reach
   * for services through the dead context.
   */
  let unloaded = false
  const pendingSubagentPrompts = new Set<AbortController>()
  ctx.effect(() => () => {
    unloaded = true
    for (const controller of pendingSubagentPrompts) controller.abort()
    pendingSubagentPrompts.clear()
  })
  const editor = ctx.mayflyComponents.createEditor()
  /** The facts of the editor's frame: the conversation title (sanitized, one line) and whether the buffer is a shell command. */
  const frame: { title: string | undefined, shell: boolean } = { title: undefined, shell: false }

  const notificationOwner = ctx.mayflyUiInteraction.createNotificationOwner('mayfly.input')
  ctx.effect(() => () => notificationOwner.dispose())
  const notificationScope = (): MayflyUiScope => {
    const agent = ctx.mayflyCurrentAgent.current()
    return agent === null ? { kind: 'app', targetId: 'prompt' } : { kind: 'session', sessionId: String(agent.id) }
  }
  /** The footer under the editor holds only the slash hint; every notification is the notification pane's. */
  const feedbackNode = (): MayflyUiNode | undefined => {
    const hint = slashHint()
    return hint === undefined ? undefined : ui.text(hint, { tone: 'muted' })
  }
  const showFeedback = (id: string, message: string, severity: MayflyFeedback['severity'], detail?: string): void => {
    const summary = message.replace(/\s*[\r\n]+\s*/gu, ' · ').trim()
    const fullDetail = detail ?? (summary === message ? undefined : message)
    notificationOwner.report(id, notificationScope(), { message: summary, severity, ...(fullDetail === undefined ? {} : { detail: fullDetail }) }, id)
  }
  const extensionRuntime = new EditorExtensionRuntime({
    ctx,
    editor,
    report: (id, feedback) => notificationOwner.report(`editor-extension/${id}`, notificationScope(), feedback, id),
    footer: feedbackNode,
    frame: ({ parked }) => Editor({ ...frame.title === undefined ? {} : { title: frame.title }, shell: frame.shell, parked }),
    shouldTransformSubmit: text => ctx.mayflyCurrentAgent.current() !== null
      && draft.getStashedInputMode() !== 'bash'
      && parseCommand(text.trim()) === undefined,
  })

  /**
   * Empty-result feedback for slash-prefixed input (D43: the discovery
   * listing itself retired — the dropdown owns command discovery).
   * @returns the notice text when the filter matches nothing, else undefined.
   */
  function slashHint(): string | undefined {
    if (!currentText.startsWith('/')) return undefined
    const parsed = parseCommand(currentText)
    // A bare slash cannot parse (parseCommand requires a leading letter).
    if (parsed === undefined && currentText !== '/') return undefined
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) return undefined
    // The same S14 fuzzy filter the dropdown uses, so the feedback agrees
    // with what the dropdown just failed to list. The dropdown closes
    // itself on an empty match, so this notice is the only signal.
    const matches = filterSlashCommands(
      aliases.withCommandAliases(availableCommands(ctx, agent)),
      parsed?.name ?? '',
      ctx.mayflyComponents,
    )
    if (matches.length === 0) return `no matching command: /${parsed?.name ?? ''}`
    return undefined
  }

  /** Recompile the prompt footer from the slash state. */
  let refreshingHint = false
  function refreshHint(): void {
    if (refreshingHint) return
    refreshingHint = true
    try { extensionRuntime.refreshPresentation() } finally { refreshingHint = false }
  }

  /**
   * Restore one captured submission buffer through the adapter — raw marker
   * text plus its paste table — falling back to the expanded submission
   * text for structural editors without the seam.
   * @param submitted - the funnel capture, when the editor exposes it.
   * @param fallbackText - the text to show when no capture exists.
   */
  function restoreDraftIntoEditor(submitted: MayflySubmittedDraft | undefined, fallbackText: string): void {
    if (submitted !== undefined && editor.restoreSubmittedDraft !== undefined) {
      editor.restoreSubmittedDraft(submitted)
      return
    }
    editor.setText(submitted?.raw ?? fallbackText)
  }

  /** Put an undelivered submission back into the editor and out of its history. */
  function restoreSubmission(value: string, historyText: string | undefined, submitted: MayflySubmittedDraft | undefined): void {
    if (historyText !== undefined) {
      editor.removeLatestHistory?.(historyText)
      stashHistory()
    }
    restoreDraftIntoEditor(submitted, value)
    currentText = editor.getText()
    stashCurrentDraft()
  }

  /** Restore a subagent submission that never reached its addressed child. */
  function restoreSubagentSubmission(
    value: string,
    historyText: string | undefined,
    transformed: ReturnType<typeof applyReversibleSubmitTransformers>,
    submitted: MayflySubmittedDraft | undefined,
    error: unknown,
  ): void {
    transformed.rollback?.()
    restoreSubmission(value, historyText, submitted)
    showFeedback('subagent-submit', error instanceof Error ? error.message : String(error), 'error')
    screen.requestRender()
  }

  /** Deliver one transformed editor submission through the subagent browser API. */
  function deliverSubagentPrompt(
    value: string,
    historyText: string | undefined,
    transformed: ReturnType<typeof applyReversibleSubmitTransformers>,
    submitted: MayflySubmittedDraft | undefined,
  ): boolean {
    const target = conversations.displayed()
    if (target?.kind !== 'subagent' || target.mode !== 'continuable' || target.access === 'readonly') {
      restoreSubagentSubmission(value, historyText, transformed, submitted, 'the subagent is no longer available for input')
      return false
    }
    const viewRevision = conversations.revision()
    const controller = new AbortController()
    pendingSubagentPrompts.add(controller)
    const ref = requests.begin('subagent')
    const attachments = ctx.get('attachments') as AttachmentReader | undefined
    void subagentPromptParts(attachments, transformed.blocks, controller.signal).then(content => subagents.prompt({
      requestId: randomUUID() as SubagentPromptRequestId,
      parentSessionId: SessionId(target.parentSessionId),
      childSessionId: SessionId(target.sessionId),
      mode: 'continuable',
      // Queue for the child's next turn: the child conversation's editor is a
      // follow-up channel, not mid-step steering (the upstream host default).
      delivery: 'queue',
      content,
    }, controller.signal)).then(receipt => {
      if (unloaded || controller.signal.aborted || conversations.revision() !== viewRevision) return
      retractionCandidate = {
        messageId: String(receipt.messageId),
        editorText: value,
        historyText: historyText ?? '',
        ...(submitted === undefined ? {} : { submitted }),
        ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
      }
    }, error => {
      requests.transition(ref, 'failed', error instanceof Error ? error.message : String(error))
      if (unloaded || controller.signal.aborted || conversations.revision() !== viewRevision) {
        transformed.rollback?.()
        return
      }
      restoreSubagentSubmission(value, historyText, transformed, submitted, error)
    }).finally(() => {
      pendingSubagentPrompts.delete(controller)
    })
    return true
  }

  /** Whether the message still sits in either of the Agent's pending lanes. */
  function messagePending(agent: Agent, messageId: string): boolean {
    return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => String(message.id) === messageId)
  }

  /**
   * Rebuild editable text for a queued message this editor did not submit:
   * text blocks concatenate as stored; each image block mints a fresh
   * `[image #N size]` marker into the paste-image state, so a resubmission
   * re-splits it into an image block.
   * @param message - the withdrawn message.
   * @returns the editor-ready text.
   */
  function foreignDraftText(message: UserMessage): string {
    const state = ctx.mayflyInteractionState.pasteImage
    return message.content.map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') {
        state.pasteCount += 1
        const marker = imageMarker(state.pasteCount, block.attachment.bytes)
        state.pastedImages.set(marker, block.attachment)
        return marker
      }
      return ''
    }).join('')
  }

  /**
   * Put one withdrawn message into the editor: the captured buffer —
   * raw marker text plus its paste table — when this editor submitted it,
   * otherwise the reconstruction from content blocks. History and rollback
   * follow the same rules as the Escape retraction restore. A draft the
   * prompt already held goes to the history first, so one Up brings it back.
   * @param message - the removed inbox message.
   * @param record - its restore data, snapshotted before `remove()`.
   */
  function restoreQueuedMessage(message: UserMessage, record: QueuedDraft | undefined): void {
    const id = String(message.id)
    queuedDrafts.delete(id)
    if (retractionCandidate?.messageId === id) retractionCandidate = undefined
    record?.rollback?.()
    // The queued entry leaves the history while it is still the newest; the displaced draft joins it after.
    if (record?.historyText !== undefined) editor.removeLatestHistory?.(record.historyText)
    const displaced = editor.getText()
    if (displaced.trim().length > 0) editor.addToHistory(displaced)
    stashHistory()
    // `foreignDraftText` mints fresh image markers — the `??` keeps it lazy
    // so a recorded buffer never triggers the fallback's registrations.
    const buffer = record?.buffer
    if (buffer !== undefined && editor.restoreSubmittedDraft !== undefined) editor.restoreSubmittedDraft(buffer)
    else editor.setText(buffer?.raw ?? foreignDraftText(message))
    currentText = editor.getText()
    stashCurrentDraft()
    refreshHint()
    screen.requestRender()
  }

  /** The pending user message with this id, in whichever lane of the Agent's inbox holds it. */
  function pendingMessage(agent: Agent, id: string): { readonly message: UserMessage, readonly lane: 'turn' | 'step' } | undefined {
    for (const [lane, messages] of [['step', agent.inbox.nextStep], ['turn', agent.inbox.nextTurn]] as const) {
      const message = messages.find(candidate => String(candidate.id) === id && candidate.source.kind === 'user')
      if (message !== undefined) return { message, lane }
    }
    return undefined
  }

  /** The last message `d` cancelled, kept for `u` while the undo window lasts. */
  let cancelled: { readonly message: UserMessage, readonly lane: 'turn' | 'step', readonly agent: Agent, readonly at: number } | undefined
  const UNDO_WINDOW_MS = 8000

  /**
   * One of the stream's keys on a queued message: `e` takes it into the prompt, `s` sends it now to the running
   * turn's steer lane, `d` cancels it (the notice offers `u`), `u` takes the last cancelled one back. `remove()`
   * emits `agent/inbox/discarded` synchronously, which retires the restore record — it is snapshotted first. A message
   * the Agent claimed between the key and here fails `remove()`: the row is gone already, and the notice says so.
   * @param action - what was asked.
   * @param id - the inbox message's id; none for `undo`.
   */
  function queuedAction(action: MayflyQueuedAction, id: string | undefined): void {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) return
    if (action === 'undo') {
      if (cancelled === undefined || cancelled.agent !== agent || Date.now() - cancelled.at > UNDO_WINDOW_MS) return
      const { message, lane } = cancelled
      cancelled = undefined
      // Back in the lane it left: a steering message keeps steering.
      if (lane === 'step') agent.steer(message)
      else agent.followup(message)
      notificationOwner.clearAll()
      showFeedback('queued', t('Message queued again'), 'success')
      return
    }
    const found = id === undefined ? undefined : pendingMessage(agent, id)
    if (found === undefined) {
      showFeedback('queued', t('The agent already read it'), 'info')
      return
    }
    const { message, lane } = found
    const record = queuedDrafts.get(String(message.id))
    if (!agent.inbox.remove(message.id)) {
      showFeedback('queued', t('The agent already read it'), 'info')
      return
    }
    if (action === 'edit') {
      restoreQueuedMessage(message, record)
      return
    }
    if (action === 'steer') {
      agent.steer(message)
      // The restore record follows the message into the steer lane (a withdrawal restores the same buffer).
      if (record !== undefined && messagePending(agent, String(message.id))) queuedDrafts.set(String(message.id), record)
      return
    }
    // Cancel: the text stays one Up away in the history (it was added when it was sent); `u` brings the message back.
    if (retractionCandidate?.messageId === String(message.id)) retractionCandidate = undefined
    cancelled = { message, lane, agent, at: Date.now() }
    showFeedback('queued', t('Cancelled · u undo'), 'info')
  }

  /**
   * Route one submitted line to the command registry or the agent, record
   * it in the editor history, and clear the buffer.
   * @param value - the expanded editor content.
   */
  function submitPrompt(value: string): void {
    const line = value.trim()
    retractionCandidate = undefined
    // The funnel captured this submission's raw buffer and paste table;
    // read it once here regardless of which route the line takes.
    const submitted = editor.consumeSubmittedDraft?.()
    notificationOwner.clearAll()
    editor.setText('')
    // Re-sync explicitly: whether setText fires onChange is the component's
    // own behavior, and the hint must never lag the buffer.
    currentText = editor.getText()
    // The draft was consumed; drop the reload stash with it.
    draft.clearDraft()
    refreshHint()
    if (line.length === 0) return
    editor.addToHistory(line)
    // The history lives in the component; a `/theme <name>` submission
    // rebuilds this fiber (and the editor) as its own effect, so the new
    // entry must reach the reload stash before the swap tears the
    // component down.
    stashHistory()
    const parsed = parseCommand(line)
    // A displayed conversation without a driven Agent still runs commands
    // against its primary; only its messages follow the displayed access.
    const agent = ctx.mayflyCurrentAgent.current() ?? (parsed === undefined ? null : ctx.mayflyCurrentAgent.primary())
    if (agent === null) {
      const displayed = conversations.displayed()
      if (displayed === null) {
        showFeedback('prompt-submit', t('no active session'), 'error')
        return
      }
      restoreSubmission(value, line, submitted)
      // A stored continuable child resumes only through the explicit reply
      // form; the draft stays here until that form sends it.
      if (displayed.kind === 'subagent' && displayed.access === 'resumable') ctx.emit('mayfly/request-subagent-reply', displayed, line)
      else showFeedback('prompt-submit', t('this conversation is read-only'), 'warning')
      screen.requestRender()
      return
    }
    if (parsed === undefined) {
      const prepared = extensionRuntime.takePrepared(value)
      const preparedTransformation = prepared?.transformation
      const transformed = preparedTransformation === undefined
        ? applyReversibleSubmitTransformers(ctx, rewriteSkillTokens(ctx, prepared?.text ?? line))
        : {
            ...preparedTransformation,
            blocks: preparedTransformation.blocks.map(block => block.type === 'text'
              ? { ...block, text: rewriteSkillTokens(ctx, block.text) }
              : block),
          }
      const displayed = conversations.displayed()
      if (displayed?.kind === 'subagent') {
        deliverSubagentPrompt(value, line, transformed, submitted)
        return
      }
      try {
        const message = createUserMessage({ content: transformed.blocks, source: { kind: 'user' } })
        agent.followup(message)
        // Keep restore data only while the message still waits in the
        // inbox — an idle agent claims it inside this call, and only a
        // pending entry is withdrawable.
        if (messagePending(agent, String(message.id))) {
          queuedDrafts.set(String(message.id), {
            ...(submitted === undefined ? {} : { buffer: submitted }),
            historyText: line,
            ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
          })
        }
        retractionCandidate = {
          messageId: String(message.id),
          editorText: value,
          historyText: line,
          ...(submitted === undefined ? {} : { submitted }),
          ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
        }
      } catch (error) {
        transformed.rollback?.()
        showFeedback('prompt-submit', error instanceof Error ? error.message : String(error), 'error')
        return
      }
      ctx.mayflyRequests.begin(displayed?.kind === 'btw' ? 'btw' : 'main')
      // The S29 skill pipeline rewrites only model-facing text; the editor
      // candidate and history retain exactly what the user submitted.
      return
    }
    // A bare command line may route to a surface instead of its handler —
    // see BARE_COMMAND_ROUTES (`/permission` opens the preset picker; a
    // `/permission <name>` argument passes through to the upstream write
    // path the picker itself dispatches).
    if (parsed.rawInput.trim().length === 0 && BARE_COMMAND_ROUTES[parsed.name]?.(ctx) === true) return
    // An alias line (`/q`) is rewritten to its canonical command before
    // dispatch — the kimi resolution: aliases are not registered commands,
    // the canonical name owns the handler and the session log. The raw
    // input after the name travels untouched.
    const canonical = aliases.canonicalOf(parsed.name)
    const commandName = canonical ?? parsed.name
    void ctx.commands.execute(
      agent,
      canonical === undefined ? line : `/${commandName}${parsed.rawInput}`,
      [],
      new AbortController().signal,
    ).then(
      (execution) => {
        // The fiber may be gone — `/theme` unloads it mid-execution — and
        // the reloaded fiber repaints, so a late notice is moot.
        if (unloaded) return
        if (execution === undefined) showFeedback('command', t('unknown command: {command}', { command: line }), 'error')
        else if (execution.result.kind === 'error') showFeedback('command', execution.result.text, 'error')
        else if (execution.result.text !== undefined && !QUIET_COMMANDS.has(commandName)) showFeedback('command', execution.result.text, 'info')
      },
      (error: unknown) => {
        if (unloaded) return
        /* execute() normalizes handler rejections to Error before this rejection handler runs */
        showFeedback('command', error instanceof Error ? error.message : String(error), 'error')
      },
    )
  }

  /**
   * Hand the draft to the external editor ($VISUAL/$EDITOR, Ctrl-G, S31).
   * The screen suspends while the child owns the tty; the edited text is
   * written back inside the suspend window so the resumed full frame
   * already shows it. A nonzero exit (`:cq`) resolves `undefined` and the
   * draft stays untouched; a missing editor only flashes a notice. The
   * mirrors re-sync explicitly because setText fires no onChange, so a
   * theme-swap reload keeps the edited draft.
   */
  async function runExternalEditorFlow(): Promise<void> {
    const command = resolveExternalEditorCommand(process.env, currentMayflySettings(ctx).editorCommand)
    if (command === undefined) {
      showFeedback('external-editor', t('set $VISUAL or $EDITOR to edit drafts externally'), 'warning')
      return
    }
    externalEditorRunning = true
    try {
      // Seed through getExpandedText(): large pastes materialize as their
      // full text (the upstream-sanctioned external-editor form). Image
      // markers ride as literal text and keep resolving at submit — the
      // paste-image state is tree-owned and unaffected by setText.
      const seed = editor.getExpandedText()
      const pasted = [...(editor.captureDraft?.().pastes.values() ?? [])]
      await screen.suspend(async () => {
        const edited = await runExternalEditor(seed, command)
        // :cq / a mid-suspend fiber unload: the draft stays untouched.
        if (edited === undefined || unloaded) return
        // The pasted blocks that came back unchanged fold into their markers again.
        editor.setTextFolding(edited.replaceAll('\r\n', '\n').replace(/\n$/, ''), pasted)
        currentText = editor.getText()
        stashCurrentDraft()
        refreshHint()
      })
    } catch (error) {
      // The launcher rejected (spawn failure); resume already ran, so the
      // notice paints on the live screen — unless the fiber went with it.
      if (!unloaded) showFeedback('external-editor', error instanceof Error ? error.message : String(error), 'error')
    } finally {
      externalEditorRunning = false
    }
  }

  /** Clear the current draft without changing request state. */
  /** Clear the current draft; the cleared text stays one Up away in history. */
  function clearDraft(): boolean {
    const text = editor.getText()
    if (text.length === 0) return false
    editor.addToHistory(text)
    stashHistory()
    editor.setText('')
    currentText = ''
    draft.clearDraft()
    showFeedback('draft', t('draft cleared · ↑ restores'), 'info')
    refreshHint()
    screen.requestRender()
    return true
  }

  /** Request an ordinary interrupt; this path must never retract a message. */
  function interrupt(): boolean {
    retractionCandidate = undefined
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) return false
    const result = interruptAgent(ctx, agent, conversations.displayed())
    if (!result.requested) return false
    ctx.mayflyRequests.interrupt()
    // The activity row answers the keypress on this frame: the native turn
    // keeps draining a started tool for a while, and the spinner must not
    // sit there looking ignored while it does.
    ctx.mayflyRequests.requestStop()
    showFeedback('interrupt', result.failures.length === 0
      ? t('interrupt requested')
      : t('interrupt requested with failures: {failures}', { failures: result.failures.join('; ') }), result.failures.length === 0 ? 'info' : 'warning')
    return true
  }

  /** Whether the selected Agent currently runs a turn (a running subagent alone is not a flow of this conversation). */
  function sessionFlowInProgress(): boolean {
    const agent = ctx.mayflyCurrentAgent.current()
    return agent !== null && isAgentRunning(agent)
  }

  /**
   * Interrupt current work first, then clear a draft only when idle — the
   * programmatic `abortPrompt` seam. The editor keys split that behavior:
   * Escape interrupts a running flow, Ctrl-C only empties the box.
   */
  function interruptOrClear(): boolean {
    if (interrupt()) return true
    return clearDraft()
  }

  /**
   * Escape: a running session flow is interrupted — safe retraction first
   * when the buffer is empty and the just-submitted message is eligible —
   * and the draft is never touched. Idle, it clears the draft.
   */
  function escapeInterruptOrClear(): boolean {
    if (sessionFlowInProgress()) {
      // Retraction rewrites the editor text, so it only runs on an empty
      // buffer — a non-empty draft must never be clobbered by the restore.
      if (editor.getText().length === 0) {
        const candidate = retractionCandidate
        if (candidate !== undefined
          && ctx.mayflyRetractions.tryRetract(candidate.messageId)) {
          candidate.rollback?.()
          editor.removeLatestHistory?.(candidate.historyText)
          stashHistory()
          queuedDrafts.delete(candidate.messageId)
          restoreDraftIntoEditor(candidate.submitted, candidate.editorText)
          currentText = editor.getText()
          stashCurrentDraft()
          retractionCandidate = undefined
          refreshHint()
          screen.requestRender()
          return true
        }
      }
      return interrupt()
    }
    return clearDraft()
  }

  /**
   * The hint that follows the active token: the keys that act on it, in the notification pane's teaching slot. An image
   * has no editor to open it in.
   * @param token - the token the caret is on or Backspace selected, or `undefined` when there is none.
   */
  function announceToken(token: MayflyEditorToken | undefined): void {
    ctx.emit('mayfly/prompt-hint-changed', token === undefined ? undefined : token.kind === 'image' ? t('Ctrl+G shows it · Backspace removes') : t('Ctrl+G opens · Backspace removes'))
    // The hint shares its place with the notices of this prompt (`pasted 1 image`): the keys of the token on show win.
    if (token !== undefined) notificationOwner.clearAll()
  }

  /**
   * Ctrl-G on an image token: the image in an overlay (a terminal without an image protocol shows its name and size).
   * @param token - the image token the caret is on.
   */
  function showImagePreview(token: MayflyEditorToken): void {
    const ref = ctx.mayflyInteractionState.pasteImage.pastedImages.get(token.text)
    if (ref === undefined) return
    // The picture's first row carries the whole image, so the surface must show it: the image is as tall as the editor's
    // slot leaves after the frame's own rows, and the overlay may take that whole slot.
    const rows = Math.max(IMAGE_PREVIEW_MIN_ROWS, Math.min(IMAGE_PREVIEW_ROWS, ctx.mayflyScreen.editorViewport.rows - IMAGE_PREVIEW_CHROME_ROWS))
    const node = ui.surface({ title: token.text, chrome: 'overlay', padding: 1, child: ui.stack.column([
      ui.image({ attachmentId: String(ref.attachmentId), alt: token.text, maxRows: rows }),
      ui.actions({ id: 'image-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
    ]) })
    openUiOverlay(ctx, { id: 'mayfly.image-preview', presentation: 'editor', capturing: true, dismissal: 'discard', maxHeight: '100%', title: token.text, scope: { kind: 'app', targetId: 'image-preview' } }, node, { reopen: 'replace' })
  }

  /**
   * Ctrl-G on a token: a mentioned file or folder opens in the editor where it lies; a pasted block opens as text, and
   * what is saved takes the token's place as plain text.
   * @param token - the active token.
   */
  async function openTokenInEditor(token: MayflyEditorToken): Promise<void> {
    const command = resolveExternalEditorCommand(process.env, currentMayflySettings(ctx).editorCommand)
    if (command === undefined) {
      showFeedback('external-editor', t('set $VISUAL or $EDITOR to edit drafts externally'), 'warning')
      return
    }
    let file: string | undefined
    if (token.kind === 'mention') {
      file = mentionFile(token.text, sessionCwd(ctx))
      if (!existsSync(file)) {
        showFeedback('external-editor', t('{path} does not exist', { path: displayPath(file) }), 'warning')
        return
      }
    }
    externalEditorRunning = true
    try {
      await screen.suspend(async () => {
        if (file !== undefined) {
          await openFileInExternalEditor(file, command)
          return
        }
        const edited = await runExternalEditor(token.content ?? token.text, command)
        if (edited === undefined || unloaded) return
        editor.replaceActiveToken(edited.replaceAll('\r\n', '\n').replace(/\n$/, ''))
        currentText = editor.getText()
        stashCurrentDraft()
        refreshHint()
      })
    } catch (error) {
      if (!unloaded) showFeedback('external-editor', error instanceof Error ? error.message : String(error), 'error')
    } finally {
      externalEditorRunning = false
    }
  }

  /**
   * Ctrl-G on the focused file of the `@` list: the file opens in the editor where it lies; the draft, the caret and the
   * list stay as they were.
   * @param value - the file's completion value, `@path` or `@"my path"`.
   */
  async function openFocusedMention(value: string): Promise<void> {
    const command = resolveExternalEditorCommand(process.env, currentMayflySettings(ctx).editorCommand)
    if (command === undefined) {
      showFeedback('external-editor', t('set $VISUAL or $EDITOR to edit drafts externally'), 'warning')
      return
    }
    const file = mentionFile(value, sessionCwd(ctx))
    if (!existsSync(file)) {
      showFeedback('external-editor', t('{path} does not exist', { path: displayPath(file) }), 'warning')
      return
    }
    externalEditorRunning = true
    try {
      await screen.suspend(() => openFileInExternalEditor(file, command))
    } catch (error) {
      if (!unloaded) showFeedback('external-editor', error instanceof Error ? error.message : String(error), 'error')
    } finally {
      externalEditorRunning = false
    }
  }

  /**
   * Take the focused folder of the `@` list as a mention: the editor completes it (the caret ends inside a closing
   * quote of a quoted path), a space ends the mention so the list closes, and the path is remembered as a token.
   * @param value - the folder's completion value, `@dir/` or `@"my dir/"`.
   */
  function selectFolderMention(value: string): void {
    editor.handleInput?.('\t')
    if (value.endsWith('"') || value.endsWith("'")) editor.handleInput?.('\x1b[C')
    editor.insertText(' ')
    ctx.mayflyInteractionState.mentions.add(value)
    editor.refreshAutocomplete()
  }

  /** Mirror the history and the paste tables of its entries into the reload stash. */
  function stashHistory(): void {
    draft.stashHistory(editor.getHistory(), editor.getHistoryPastes())
  }

  /** Mirror the live buffer and its paste table into the reload stash. */
  function stashCurrentDraft(): void {
    draft.stashDraft(editor.captureDraft?.() ?? { raw: editor.getText(), pastes: new Map() })
  }

  /**
   * The editor-context key chain, resolved through the keymap before the
   * pi-tui Editor sees the sequence (it swallows Ctrl-C with no behavior,
   * so interception must happen here). Returns true to consume.
   * @param data - the input sequence as read from the terminal.
   * @returns whether the sequence was consumed.
   */
  function handleEditorKey(data: string): boolean {
    const keymap = ctx.mayflyKeymap
    // Backspace at a token: on a highlighted token it removes it; right after one it selects it first. The editor says
    // which token is active, and the hint under the prompt follows it. A completion list that reopened behind the caret
    // (the mention's own) does not keep the key.
    if (keymap.matches(data, ACTION_BACKSPACE) && editor.tokenBackspace()) return true
    // Ctrl-G on a token opens that, not the whole draft: a file or a pasted block in the editor, an image in a preview.
    if (keymap.matches(data, ACTION_EXTERNAL_EDITOR)) {
      // With the `@` list open, the focused file is what Ctrl-G opens, before any token behind the caret (a folder is
      // taken with Enter or entered with Tab).
      const view = editor.isShowingAutocomplete() ? editor.completion() : undefined
      const row = view?.kind === 'files' ? view.items[view.index] : undefined
      if (row !== undefined && row.source === undefined && row.problem === undefined && !row.label.endsWith('/')) {
        if (!externalEditorRunning) void openFocusedMention(row.value)
        return true
      }
      const token = editor.activeToken()
      if (token?.kind === 'image') {
        showImagePreview(token)
        return true
      }
      if (token !== undefined) {
        if (!externalEditorRunning) void openTokenInEditor(token)
        return true
      }
    }
    // Enter on a folder of the `@` list takes the folder as a mention (Tab goes into it): the path lands in the prompt
    // as a token and the list closes.
    if (keymap.matches(data, ACTION_SUBMIT) && editor.isShowingAutocomplete()) {
      const view = editor.completion()
      const item = view?.kind === 'files' ? view.items[view.index] : undefined
      if (item !== undefined && item.label.endsWith('/')) {
        selectFolderMention(item.value)
        return true
      }
    }
    // Escape: an open autocomplete dropdown owns the key (the Editor closes
    // it); otherwise interrupt a running flow — safe retraction first when
    // eligible — or clear an idle draft.
    if (keymap.matches(data, ACTION_CANCEL)) {
      if (editor.isShowingAutocomplete()) return false
      return escapeInterruptOrClear()
    }
    // Ctrl-C never enters Escape's retraction path. A draft is the only
    // thing it touches while a flow runs: it empties the box and the flow
    // continues. With an empty buffer it requests the ordinary interrupt
    // (latching the stopping row); idle, it arms the double-press exit.
    if (keymap.matches(data, ACTION_INTERRUPT)) {
      if (clearDraft()) return true
      if (sessionFlowInProgress()) return interrupt()
      const now = Date.now()
      if (now - lastInterruptAt < INTERRUPT_DOUBLE_PRESS_MS) {
        lastInterruptAt = 0
        // Same exit path as `/quit`: optional, launcher-provided.
        ctx.get('appExit')?.(0)
        return true
      }
      lastInterruptAt = now
      showFeedback('exit', t('press Ctrl+C again to exit'), 'warning')
      return true
    }
    // Ctrl-S: steer the current turn with the draft — an idle agent starts
    // a turn, a running one consumes it at the next step boundary.
    if (keymap.matches(data, ACTION_STEER)) {
      const text = editor.getText().trim()
      const agent = ctx.mayflyCurrentAgent.current()
      if (text.length === 0 || agent === null) return false
      // The steer path never crosses the submit funnel, so snapshot the
      // buffer and paste table directly for a possible withdrawal.
      const submitted = editor.captureDraft?.()
      // Steered text runs the same `#name` → `/name` skill rewrite as a
      // submitted follow-up: the gesture reaches the model either way.
      const transformed = applyReversibleSubmitTransformers(ctx, rewriteSkillTokens(ctx, text))
      const displayed = conversations.displayed()
      if (displayed?.kind === 'subagent') {
        if (deliverSubagentPrompt(text, undefined, transformed, submitted)) {
          editor.setText('')
          currentText = ''
          draft.clearDraft()
          refreshHint()
        }
        return true
      }
      try {
        const message = createUserMessage({ content: transformed.blocks, source: { kind: 'user' } })
        agent.steer(message)
        if (messagePending(agent, String(message.id))) {
          queuedDrafts.set(String(message.id), {
            ...(submitted === undefined ? {} : { buffer: submitted }),
            ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
          })
        }
      } catch (error) {
        transformed.rollback?.()
        showFeedback('steer', error instanceof Error ? error.message : String(error), 'error')
        return true
      }
      ctx.mayflyRequests.begin(displayed?.kind === 'btw' ? 'btw' : 'main')
      editor.setText('')
      currentText = ''
      // Steered text is consumed too: keep no stashed copy for a reload.
      draft.clearDraft()
      refreshHint()
      return true
    }
    // Shift+Tab toggles native plan state, including in bash input mode.
    // Permission presets are independent and require an explicit command.
    if (keymap.matches(data, ACTION_CYCLE_MODE)) {
      void cycleMode(ctx, (id, feedback) => notificationOwner.report(id, notificationScope(), feedback, id))
      return true
    }
    // Ctrl-G: hand the draft to $VISUAL/$EDITOR (S31). The terminal
    // suspends while the child owns the tty; the edited text is written
    // back inside the suspend window. A second press while an editor
    // session runs is consumed silently.
    if (keymap.matches(data, ACTION_EXTERNAL_EDITOR)) {
      if (!externalEditorRunning) void runExternalEditorFlow()
      return true
    }
    // Alt+M: cycle the session model within the current provider through
    // the session-only channel (S30). The switch flashes its notice and
    // leaves the draft alone — reaching /model would consume the typed
    // line, which is exactly what the hotkey avoids. Always consumed for
    // the same reasons as the mode cycle, and it fires in bash mode too
    // (input mode and model are orthogonal axes).
    if (keymap.matches(data, ACTION_CYCLE_MODEL)) {
      void cycleSessionModel(ctx, modelListCache, (id, feedback) => notificationOwner.report(id, notificationScope(), feedback, id))
      return true
    }
    // Alt+Down (F5) on an empty prompt enters the views of status row 2; without a view the key stays the editor's.
    if (keymap.matches(data, ACTION_FOCUS_NEXT)
      && editor.getText().length === 0
      && !editor.isShowingAutocomplete()
      && ctx.mayflyScreen.enterViews()) return true
    // Alt+Up (F4) moves focus up into the conversation, where the cursor walks its rows; a draft stays in the prompt, so it never keeps the reader from a queued message.
    if (keymap.matches(data, ACTION_FOCUS_PREV)
      && !editor.isShowingAutocomplete()
      && ctx.mayflyScreen.focusConversation()) return true
    return false
  }

  /** Tell the notification pane where the prompt stands in its history, once per move. */
  let recallShown = ''
  function publishRecall(): void {
    const position = editor.getHistoryPosition?.()
    const key = position === undefined ? '' : `${String(position.index)}/${String(position.total)}`
    if (key === recallShown) return
    recallShown = key
    ctx.emit('mayfly/prompt-recall-changed', position)
  }

  editor.onChange = (text) => {
    currentText = text
    publishRecall()
    // Mirror every edit so a theme-swap reload loses nothing.
    stashCurrentDraft()
    notificationOwner.clearAll()
    refreshHint()
  }
  editor.onKey = handleEditorKey
  editor.setTokenSource(createTokenSource(ctx))
  // The preview's bytes: a pasted image is known by the tree until it is sent, and the stream's own loader answers after.
  ctx.effect(() => ctx.get('mayflyUiImages')?.provide(async (attachmentId) => {
    const ref = [...ctx.mayflyInteractionState.pasteImage.pastedImages.values()].find(candidate => String(candidate.attachmentId) === attachmentId)
    const attachments = ctx.get('attachments') as AttachmentReader | undefined
    if (ref === undefined || attachments === undefined) return undefined
    try {
      return { data: (await attachments.readImage(ref)).data, mediaType: ref.mediaType, ...ref.name === undefined ? {} : { name: ref.name } }
    } catch {
      return undefined
    }
  }) ?? (() => {}))
  editor.onTokenChange = announceToken
  ctx.effect(() => () => editor.setTokenSource(undefined))

  // Restore the draft stashed before a reload: plain text only — setText
  // fires neither a submit nor an input-mode transition. The explicit
  // re-sync mirrors submitPrompt's caution about component-owned onChange
  // timing.
  const stashed = draft.getStashedDraft()
  if (stashed.raw.length > 0) {
    // The paste table rides along, so a `[paste #N]` marker still expands after the reload.
    if (editor.restoreSubmittedDraft !== undefined) editor.restoreSubmittedDraft(stashed)
    else editor.setText(stashed.raw)
    currentText = editor.getText()
    refreshHint()
  }
  // Replay the stashed history into the fresh component — the old
  // editor's Up-recall entries died with it when the reload rebuilt this
  // fiber. The stash is newest-first and pi-tui prepends, so the replay
  // walks it reversed to land the same order.
  const stashedHistory = draft.getStashedHistory()
  const stashedPastes = draft.getStashedHistoryPastes()
  for (let index = stashedHistory.length - 1; index >= 0; index -= 1) editor.addToHistory(stashedHistory[index]!, stashedPastes[index])

  // A session switch settles navigation notices such as "resuming" and
  // "creating rewind branch". Clear the old session's transient text before
  // re-deriving slash feedback against the new agent.
  let sessionId = ctx.mayflyCurrentAgent.current()?.id
  const sessionRegistration = ctx.mayflyCurrentAgent.subscribe((agent) => {
    const nextId = agent?.id
    if (nextId !== sessionId) {
      sessionId = nextId
      retractionCandidate = undefined
      queuedDrafts.clear()
      for (const controller of pendingSubagentPrompts) controller.abort()
      pendingSubagentPrompts.clear()
    }
    extensionRuntime.invalidateSession()
    notificationOwner.clearAll()
    refreshHint()
  })
  ctx.effect(() => sessionRegistration)
  // A queued draft is only useful while its message still waits in the
  // current Agent's inbox: claims consume it for real, discards and
  // withdrawals retire the record.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) queuedDrafts.delete(String(message.id))
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (agent === ctx.mayflyCurrentAgent.current()) queuedDrafts.delete(String(message.id))
  })
  ctx.effect(() => () => queuedDrafts.clear())
  // `e`, `s`, `d`, and `u` on a queued row of the stream: this editor holds the restore data of what it queued.
  ctx.effect(() => ctx.on('mayfly/queued-action', (action, id) => { queuedAction(action, id) }))
  // The session name rides the right end of the editor's top border: the
  // official `title` projection of the exact current Agent, read through
  // the frontend session-facts bridge whenever that service is mounted.
  ctx.inject(['mayflySessionFacts'], owner => {
    const offTitle = owner.mayflySessionFacts.subscribeTitle(title => {
      const line = title === undefined ? '' : title.replace(/\s+/gu, ' ').trim()
      frame.title = line === '' ? undefined : line
      refreshHint()
    })
    owner.effect(() => () => {
      offTitle()
      frame.title = undefined
    })
  })
  ctx.effect(() => {
    const slot = screen.mountDockSlot('editor.prompt', extensionRuntime)
    slot.focus()
    // The completion list is plain rows over the stream, as wide as the frame and ending on the row above it: neither the
    // editor nor the conversation reflows when it opens.
    // What the prompt waits for shows as the palette's last line while a list is open (the notification row's loader is
    // under the palette then).
    let waiting: string | undefined
    const offWait = ctx.on('mayfly/prompt-wait-changed', message => {
      waiting = message
      screen.requestRender()
    })
    const drawer = new CompletionDrawer({
      wait: () => waiting,
      view: () => editor.completion(),
      frameWidth: () => screen.columns,
      colors: ctx.mayflyTheme.colors,
      components: ctx.mayflyComponents,
      glyphs: ctx.mayflyComponents.presentation?.glyphs,
    })
    const drawerHandle = screen.showOverlay(drawer, {
      anchor: 'bottom-left',
      nonCapturing: true,
      get width() { return drawer.width },
      get offsetY() { return -screen.editorRowsFromBottom },
      visible: () => drawer.open,
    })
    const shared = {
      editor,
      submitPrompt,
      abortPrompt: () => { interruptOrClear() },
      setShell: (shell: boolean) => {
        if (frame.shell === shell) return
        frame.shell = shell
        editor.setShellMode(shell)
        refreshHint()
      },
      report: (id: string, feedback: MayflyFeedback) => notificationOwner.report(id, notificationScope(), feedback, id),
    }
    setSharedEditor(ctx, shared)
    const detachEditorPlus = mountEditorPlus(ctx, shared, () => unloaded)
    ctx.emit('mayfly/input-editor-changed')

    return () => {
      clearSharedEditor(ctx)
      ctx.emit('mayfly/input-editor-changed')
      detachEditorPlus()
      offWait()
      drawerHandle.hide()
      extensionRuntime.dispose()
      slot.dispose()
    }
  })
  ctx.effect(() => {
    const screen = ctx.mayflyScreen as MayflyScreen & {
      setContentScrollHandler?: (handler: ((data: string) => boolean) | undefined) => () => void
    }
    const dispose = screen.setContentScrollHandler?.(data => {
      if (!extensionRuntime.focused) return false
      /* exercised by the real PTY and mouse path */
      const wheel = normalizeWheelInput(data)
      if (wheel !== undefined) {
        const direction = ctx.mayflyKeymap.matches(wheel, ACTION_MOVE_UP)
          ? 'up'
          : ctx.mayflyKeymap.matches(wheel, ACTION_MOVE_DOWN) ? 'down' : undefined
        if (direction === undefined) return false
        // The focused editor owns every wheel report, including the scroll
        // boundary. Consuming the boundary event prevents it from being
        // reinterpreted as editor history navigation; the AltScreen core
        // route remains available when no editor handler is installed.
        ctx.mayflyScreen.scrollContent(direction, 3)
        return true
      }
      /* exercised by the real PTY and mouse path */
      const pageUp = ctx.mayflyKeymap.matches(data, ACTION_PAGE_UP)
      const pageDown = ctx.mayflyKeymap.matches(data, ACTION_PAGE_DOWN)
      if (pageUp || pageDown) {
        const direction = pageUp ? 'up' : 'down'
        const amount = Math.max(1, ctx.mayflyScreen.rows - 4)
        return ctx.mayflyScreen.scrollContent(direction, amount)
      }
      // Ctrl+↓ means nothing in a draft, so it follows the tail whatever the editor holds; End is the editor's own with text.
      if (ctx.mayflyKeymap.matches(data, ACTION_FOLLOW_TAIL)) {
        ctx.mayflyScreen.followContent()
        return true
      }
      if (editor.getText().length > 0) return false
      if (ctx.mayflyKeymap.matches(data, ACTION_END)) {
        ctx.mayflyScreen.followContent()
        return true
      }
      return false
    })
    return () => dispose?.()
  })
  /* notification is driven by live streaming events */
  // A reply form opened from this draft sent it: the draft left the editor.
  ctx.effect(() => ctx.on('mayfly/subagent-reply-sent', sent => {
    if (editor.getText().trim() !== sent) return
    editor.addToHistory(sent)
    stashHistory()
    editor.setText('')
    currentText = ''
    draft.clearDraft()
    refreshHint()
    screen.requestRender()
  }))
}
