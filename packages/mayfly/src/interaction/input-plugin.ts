/**
 * `mayfly-input` plugin: the bottom input editor, backed by the pi-tui Editor
 * through `ctx.mayflyComponents.createEditor` (multi-line, kill-ring, undo,
 * history, and paste markers are the component's own). The editor mounts
 * with `paddingX: 4` and the `>` prompt symbol, feeding the rounded-box
 * chrome the core adapter overlays; slash-prefixed input highlights the
 * frame in `primary` and any other text returns the neutral border. Submit
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
 * clear/retract/interrupt, Ctrl-C selected-Agent-tree interrupt/clear/double-press exit, Ctrl-S
 * steer, Ctrl-G external
 * editor) resolves through
 * `ctx.mayflyKeymap` in the editor's `onKey` hook, which runs before the
 * pi-tui Editor sees the sequence. The mounted editor and the submit router
 * are published through
 * `./editor-instance.ts` so `mayfly-editor-plus` can layer input modes and
 * autocomplete over the same component. The `mayfly-pane-queue` enhancement
 * shows pending messages without taking over editor history. Auxiliary live
 * Agents use this same editor and transcript; delivery scope follows the
 * app-owned current-Agent view instead of a pane-specific input path. The
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
import type { Context } from '@deepseek-ai/cordis'
import type {
  MayflyComponent,
  MayflyComponents,
  MayflyScreen,
  MayflySemanticColors,
} from '../core/index.ts'
import { normalizeWheelInput } from '../core/terminal.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { PromptContentPart, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
// Carries the app-owned retraction service and event/service declaration merges.
import type {} from '../app/index.ts'
import { interruptAgentTree } from '../app/agent-interrupt.ts'
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
import { EditorDockHost } from './editor-dock-host.ts'
import { mountEditorPlus } from './editor-plus.ts'
import { resolveExternalEditorCommand, runExternalEditor } from './external-editor.ts'
import { currentMayflySettings } from './settings.ts'
import {
  ACTION_CANCEL,
  ACTION_CYCLE_MODEL,
  ACTION_EXTERNAL_EDITOR,
  ACTION_END,
  ACTION_INTERRUPT,
  ACTION_MOVE_DOWN,
  ACTION_MOVE_UP,
  ACTION_PAGE_DOWN,
  ACTION_PAGE_UP,
  ACTION_SHIFT_TAB,
  ACTION_STEER,
} from './keys.ts'
import { createModelListCache, cycleSessionModel } from './model-commands.ts'
import { cycleMode } from './mode-commands.ts'
import { openPermissionPanel } from './permission-panel.ts'
import { rewriteSkillTokens } from './skills-catalog.ts'
import { filterSlashCommands } from './slash-filter.ts'

/** Window for the double Ctrl-C exit: presses farther apart re-arm the hint. */
const INTERRUPT_DOUBLE_PRESS_MS = 1000

interface AttachmentReader {
  readImage(ref: Extract<ContentBlock, { readonly type: 'image' }>['attachment'], signal?: AbortSignal): Promise<StoredImageAttachment>
}

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
function availableCommands(ctx: Context) {
  const agent = ctx.mayflyCurrentAgent.current()
  /* v8 ignore next -- slashHint checks the current Agent immediately before this sole call site. */
  if (agent === null) return []
  return ctx.commands.list(agent).map(command => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint === undefined ? {} : { input: { hint: command.input.hint } }),
  }))
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-input'
/** Services required before the editor can mount. */
export const inject = ['mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyKeymap', 'mayflyPromptEditor', 'mayflyEditorPanels', 'mayflyPromptSubmissions', 'commands', 'sessionProjections', 'agents', 'subagents', 'mayflyCurrentAgent', 'mayflyRequests', 'mayflyRetractions', 'mayflySkillsCatalog', 'mayflyInteractionState', 'mayflyEditorExtensions']

/**
 * The single-line hint rendered under the input editor. Only the transient
 * notice tier exists and paints `muted`; with nothing transient the row
 * renders zero rows — the persistent key-affordance tier retired with the
 * S15 dogfood verdict, and the slash-discovery tier with the S34 dogfood
 * verdict (D43): the editor's autocomplete dropdown already lists the same
 * catalog through the same fuzzy filter, interactively, so the discovery
 * row only ever surfaced alongside-or-after it as a duplicate. The row
 * keeps the empty-result feedback (`no matching command: /x` — the
 * dropdown closes itself on an empty match, so the notice is the only
 * signal) and every one-shot command notice.
 */
class HintLine implements MayflyComponent {
  private text: string | undefined

  /**
   * @param screen - the screen service, captured at mount (same fiber
   *   lifetime; property access through a disposed context throws).
   * @param colors - the active semantic color table.
   * @param components - the width-truncation helper source.
   */
  constructor(
    private readonly screen: MayflyScreen,
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
  ) {}

  /**
   * Replace the transient hint text and schedule a re-render.
   * @param text - the new hint, or `undefined` to release the row.
   */
  setHint(text: string | undefined): void {
    this.text = text
    this.screen.requestRender()
  }

  /** No cached render state. */
  invalidate(): void {}

  /**
   * Render the hint as wrapped rows, or nothing. Width handling goes through
   * `mayflyComponents`, so rows carrying ANSI styling (error notices) are never
   * cut mid-sequence.
   * @param width - current viewport width in columns.
   * @returns one string per rendered row.
   */
  render(width: number): string[] {
    if (this.text === undefined) return []
    const rows = this.text.split(/\r\n?|\n/u).flatMap(line => {
      const wrapped = this.components.wrapText(line.trim(), Math.max(1, width))
      /* c8 ignore next -- the renderer normally returns one row for an empty line. */
      return wrapped.length === 0 ? [''] : wrapped
    })
    const maxRows = 8
    if (rows.length <= maxRows) return rows.map(row => this.colors.muted(row))
    const visible = rows.slice(0, maxRows - 1)
    visible.push(this.components.truncateToWidth('... more', width))
    return visible.map(row => this.colors.muted(row))
  }
}

/**
 * Mount the input editor with the hint line pinned below it and focus the
 * editor; both revert when the plugin's fiber unloads.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const screen = ctx.mayflyScreen
  const colors = ctx.mayflyTheme.colors
  const currentAgent = ctx.mayflyCurrentAgent
  const requests = ctx.mayflyRequests
  const subagents = ctx.subagents
  const aliases = ctx.mayflyInteractionState.aliases
  const draft = ctx.mayflyInteractionState.draft
  const modelListCache = createModelListCache()
  /** One-shot notice shown in the hint line until the next edit. */
  let notice: string | undefined
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
    readonly rollback?: () => void
  } | undefined
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
  const editor = ctx.mayflyComponents.createEditor({ paddingX: 4 })
  // The padding reserves columns 0-3 for the side border, its gap, and the
  // `>` prompt symbol the rounded-box chrome overlays.
  editor.setPromptSymbol('>')

  const hintLine = new HintLine(screen, colors, ctx.mayflyComponents)
  const extensionRuntime = new EditorExtensionRuntime({
    ctx,
    editor,
    notice: text => setNotice(text),
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
    if (ctx.mayflyCurrentAgent.current() === null) return undefined
    // The same S14 fuzzy filter the dropdown uses, so the feedback agrees
    // with what the dropdown just failed to list. The dropdown closes
    // itself on an empty match, so this notice is the only signal.
    const matches = filterSlashCommands(
      aliases.withCommandAliases(availableCommands(ctx)),
      parsed?.name ?? '',
      ctx.mayflyComponents,
    )
    if (matches.length === 0) return `no matching command: /${parsed?.name ?? ''}`
    return undefined
  }

  /** Recompute the hint line from the notice or the slash feedback. */
  function refreshHint(): void {
    hintLine.setHint(notice ?? slashHint())
  }

  /** Flash a notice in the hint line. */
  function setNotice(text: string): void {
    notice = text === '' ? undefined : text
    refreshHint()
  }

  /** Restore a subagent submission that never reached its addressed child. */
  function restoreSubagentSubmission(
    value: string,
    historyText: string | undefined,
    transformed: ReturnType<typeof applyReversibleSubmitTransformers>,
    error: unknown,
  ): void {
    transformed.rollback?.()
    if (historyText !== undefined) {
      editor.removeLatestHistory?.(historyText)
      draft.stashHistory(editor.getHistory())
    }
    editor.setText(value)
    currentText = editor.getText()
    draft.stashDraft(currentText)
    setNotice(colors.error(error instanceof Error ? error.message : String(error)))
    screen.requestRender()
  }

  /** Deliver one transformed editor submission through the subagent browser API. */
  function deliverSubagentPrompt(
    value: string,
    historyText: string | undefined,
    transformed: ReturnType<typeof applyReversibleSubmitTransformers>,
  ): boolean {
    const view = currentAgent.view()
    const target = view.displayed === 'auxiliary' ? view.auxiliary : null
    if (target?.kind !== 'subagent' || target.mode !== 'continuable' || target.access !== 'interactive') {
      restoreSubagentSubmission(value, historyText, transformed, 'the subagent is no longer available for input')
      return false
    }
    const viewRevision = view.revision
    const controller = new AbortController()
    pendingSubagentPrompts.add(controller)
    const ref = requests.begin('subagent')
    const attachments = ctx.get('attachments') as AttachmentReader | undefined
    void subagentPromptParts(attachments, transformed.blocks, controller.signal).then(content => subagents.prompt({
      requestId: randomUUID() as SubagentPromptRequestId,
      parentSessionId: SessionId(target.parentSessionId),
      childSessionId: SessionId(target.sessionId),
      mode: 'continuable',
      content,
    }, controller.signal)).then(receipt => {
      if (unloaded || controller.signal.aborted || currentAgent.view().revision !== viewRevision) return
      retractionCandidate = {
        messageId: String(receipt.messageId),
        editorText: value,
        historyText: historyText ?? '',
        ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
      }
    }, error => {
      requests.transition(ref, 'failed', error instanceof Error ? error.message : String(error))
      if (unloaded || controller.signal.aborted || currentAgent.view().revision !== viewRevision) {
        transformed.rollback?.()
        return
      }
      restoreSubagentSubmission(value, historyText, transformed, error)
    }).finally(() => {
      pendingSubagentPrompts.delete(controller)
    })
    return true
  }

  /**
   * Route one submitted line to the command registry or the agent, record
   * it in the editor history, and clear the buffer.
   * @param value - the expanded editor content.
   */
  function submitPrompt(value: string): void {
    const line = value.trim()
    retractionCandidate = undefined
    notice = undefined
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
    draft.stashHistory(editor.getHistory())
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) {
      setNotice('no active session')
      return
    }
    const parsed = parseCommand(line)
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
      const view = ctx.mayflyCurrentAgent.view()
      if (view.displayed === 'auxiliary' && view.auxiliary?.kind === 'subagent') {
        deliverSubagentPrompt(value, line, transformed)
        return
      }
      try {
        const message = createUserMessage({ content: transformed.blocks, source: { kind: 'user' } })
        agent.followup(message)
        retractionCandidate = {
          messageId: String(message.id),
          editorText: value,
          historyText: line,
          ...(transformed.rollback === undefined ? {} : { rollback: transformed.rollback }),
        }
      } catch (error) {
        transformed.rollback?.()
        setNotice(colors.error(error instanceof Error ? error.message : String(error)))
        return
      }
      ctx.mayflyRequests.begin(view.displayed === 'auxiliary' && view.auxiliary?.kind === 'btw' ? 'btw' : 'main')
      // The S29 skill pipeline rewrites only model-facing text; the editor
      // candidate and history retain exactly what the user submitted.
      return
    }
    // A bare `/permission` opens the preset picker (S24b, D33) instead of
    // the upstream command's text listing — only while the preset service
    // is composed, so a bare line degrades to the command below otherwise.
    // With an argument the line passes through untouched: `/permission
    // <name>` stays the upstream write path the picker itself dispatches.
    if (parsed.name === 'permission' && parsed.rawInput.trim().length === 0
      && ctx.get('permissionPresets') !== undefined) {
      openPermissionPanel(ctx)
      return
    }
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
        if (execution === undefined) setNotice(`unknown command: ${line}`)
        else if (execution.result.kind === 'error') setNotice(colors.error(execution.result.text))
        else if (execution.result.text !== undefined && commandName !== 'goal') setNotice(execution.result.text)
      },
      (error: unknown) => {
        if (unloaded) return
        /* v8 ignore next -- execute() normalizes handler rejections to Error before this rejection handler runs */
        setNotice(colors.error(error instanceof Error ? error.message : String(error)))
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
      setNotice('set $VISUAL or $EDITOR to edit drafts externally')
      return
    }
    externalEditorRunning = true
    try {
      // Seed through getExpandedText(): large pastes materialize as their
      // full text (the upstream-sanctioned external-editor form). Image
      // markers ride as literal text and keep resolving at submit — the
      // paste-image state is tree-owned and unaffected by setText.
      const seed = editor.getExpandedText()
      await screen.suspend(async () => {
        const edited = await runExternalEditor(seed, command)
        // :cq / a mid-suspend fiber unload: the draft stays untouched.
        if (edited === undefined || unloaded) return
        editor.setText(edited.replaceAll('\r\n', '\n').replace(/\n$/, ''))
        currentText = editor.getText()
        draft.stashDraft(currentText)
        refreshHint()
      })
    } catch (error) {
      // The launcher rejected (spawn failure); resume already ran, so the
      // notice paints on the live screen — unless the fiber went with it.
      if (!unloaded) setNotice(colors.error(error instanceof Error ? error.message : String(error)))
    } finally {
      externalEditorRunning = false
    }
  }

  /** Clear the current draft without changing request state. */
  function clearDraft(): boolean {
    if (editor.getText().length === 0) return false
    editor.setText('')
    currentText = ''
    draft.clearDraft()
    refreshHint()
    screen.requestRender()
    return true
  }

  /** Request an ordinary interrupt; this path must never retract a message. */
  function interrupt(): boolean {
    retractionCandidate = undefined
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) return false
    const result = interruptAgentTree(ctx, agent, ctx.mayflyCurrentAgent.view())
    if (!result.requested) return false
    ctx.mayflyRequests.interrupt()
    setNotice(result.failures.length === 0
      ? 'interrupt requested'
      : colors.warning(`interrupt requested with failures: ${result.failures.join('; ')}`))
    return true
  }

  /** Interrupt current work first, then clear a draft only when idle. */
  function interruptOrClear(): boolean {
    if (interrupt()) return true
    return clearDraft()
  }

  /** Escape clears a draft, then attempts safe retraction before interruption. */
  function escapeClearOrRetract(): boolean {
    if (clearDraft()) return true
    if (ctx.mayflyCurrentAgent.current()?.status === 'running') {
      const candidate = retractionCandidate
      if (candidate !== undefined
        && ctx.mayflyRetractions.tryRetract(candidate.messageId)) {
        candidate.rollback?.()
        editor.removeLatestHistory?.(candidate.historyText)
        draft.stashHistory(editor.getHistory())
        editor.setText(candidate.editorText)
        currentText = editor.getText()
        draft.stashDraft(currentText)
        retractionCandidate = undefined
        refreshHint()
        screen.requestRender()
        return true
      }
    }
    return interrupt()
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
    // Escape: an open autocomplete dropdown owns the key (the Editor closes
    // it); otherwise clear the draft, then interrupt a running agent.
    if (keymap.matches(data, ACTION_CANCEL)) {
      if (editor.isShowingAutocomplete()) return false
      return escapeClearOrRetract()
    }
    // Ctrl-C never enters Escape's retraction path. It first requests an
    // ordinary interrupt even when a next-message draft is present, then uses
    // the idle clear/double-press-exit chain when there is no work to stop.
    if (keymap.matches(data, ACTION_INTERRUPT)) {
      if (interruptOrClear()) return true
      const now = Date.now()
      if (now - lastInterruptAt < INTERRUPT_DOUBLE_PRESS_MS) {
        lastInterruptAt = 0
        // Same exit path as `/quit`: optional, launcher-provided.
        ctx.get('appExit')?.(0)
        return true
      }
      lastInterruptAt = now
      setNotice('press ctrl+c again to exit')
      return true
    }
    // Ctrl-S: steer the current turn with the draft — an idle agent starts
    // a turn, a running one consumes it at the next step boundary.
    if (keymap.matches(data, ACTION_STEER)) {
      const text = editor.getText().trim()
      const agent = ctx.mayflyCurrentAgent.current()
      if (text.length === 0 || agent === null) return false
      // Steered text runs the same `#name` → `/name` skill rewrite as a
      // submitted follow-up: the gesture reaches the model either way.
      const transformed = applyReversibleSubmitTransformers(ctx, rewriteSkillTokens(ctx, text))
      const view = ctx.mayflyCurrentAgent.view()
      if (view.displayed === 'auxiliary' && view.auxiliary?.kind === 'subagent') {
        if (deliverSubagentPrompt(text, undefined, transformed)) {
          editor.setText('')
          currentText = ''
          draft.clearDraft()
          refreshHint()
        }
        return true
      }
      try {
        agent.steer(createUserMessage({ content: transformed.blocks, source: { kind: 'user' } }))
      } catch (error) {
        transformed.rollback?.()
        setNotice(colors.error(error instanceof Error ? error.message : String(error)))
        return true
      }
      ctx.mayflyRequests.begin(view.displayed === 'auxiliary' && view.auxiliary?.kind === 'btw' ? 'btw' : 'main')
      editor.setText('')
      currentText = ''
      // Steered text is consumed too: keep no stashed copy for a reload.
      draft.clearDraft()
      refreshHint()
      return true
    }
    // Shift+Tab: cycle the session mode (normal → plan → yolo, S24a) through
    // dsh's native plan command and permission presets. The press is always
    // consumed. It fires in bash mode too — the input mode and the session
    // mode are orthogonal axes.
    if (keymap.matches(data, ACTION_SHIFT_TAB)) {
      void cycleMode(ctx)
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
      void cycleSessionModel(ctx, modelListCache)
      return true
    }
    return false
  }

  editor.onChange = (text) => {
    currentText = text
    // Mirror every edit so a theme-swap reload loses nothing.
    draft.stashDraft(text)
    // Slash context highlights the frame in `primary`; any other text
    // returns the neutral border. `mayfly-editor-plus` re-asserts its shell
    // hue on top while bash mode is active.
    editor.setBorderColor(text.trimStart().startsWith('/') ? colors.primary : colors.border)
    notice = undefined
    refreshHint()
  }
  editor.onKey = handleEditorKey

  // Restore the draft stashed before a reload: plain text only — setText
  // fires neither a submit nor an input-mode transition. The explicit
  // re-sync mirrors submitPrompt's caution about component-owned onChange
  // timing.
  const stashed = draft.getStashedDraft()
  if (stashed.length > 0) {
    editor.setText(stashed)
    currentText = editor.getText()
    refreshHint()
  }
  // Replay the stashed history into the fresh component — the old
  // editor's Up-recall entries died with it when the reload rebuilt this
  // fiber. The stash is newest-first and pi-tui prepends, so the replay
  // walks it reversed to land the same order.
  for (const entry of [...draft.getStashedHistory()].reverse()) editor.addToHistory(entry)

  // A session switch settles navigation notices such as "resuming" and
  // "creating rewind branch". Clear the old session's transient text before
  // re-deriving slash feedback against the new agent.
  let sessionId = ctx.mayflyCurrentAgent.current()?.id
  const sessionRegistration = ctx.mayflyCurrentAgent.subscribe((agent) => {
    const nextId = agent?.id
    if (nextId !== sessionId) {
      sessionId = nextId
      retractionCandidate = undefined
      for (const controller of pendingSubagentPrompts) controller.abort()
      pendingSubagentPrompts.clear()
    }
    extensionRuntime.invalidateSession()
    notice = undefined
    refreshHint()
  })
  ctx.effect(() => sessionRegistration)
  ctx.effect(() => {
    const dock = new EditorDockHost(extensionRuntime, hintLine, occupied => {
      ctx.emit('mayfly/editor-slot-swapped', occupied)
    })
    const slot = screen.mountDockSlot('editor.prompt', dock)
    slot.focus()
    const shared = { editor, submitPrompt, abortPrompt: () => { interruptOrClear() }, notice: setNotice }
    setSharedEditor(ctx, shared)
    const detachEditorPlus = mountEditorPlus(ctx, shared, () => unloaded)
    ctx.emit('mayfly/input-editor-changed')

    ctx.mayflyEditorPanels.setHost({
      mount: (component) => {
        const remove = dock.mountPanel(component)
        slot.focus()
        screen.requestRender()
        return () => {
          remove()
          slot.focus()
          screen.requestRender()
        }
      },
    })

    return () => {
      ctx.mayflyEditorPanels.setHost(undefined)
      clearSharedEditor(ctx)
      ctx.emit('mayfly/input-editor-changed')
      detachEditorPlus()
      extensionRuntime.dispose()
      dock.dispose()
      slot.dispose()
    }
  })
  ctx.effect(() => {
    const screen = ctx.mayflyScreen as MayflyScreen & {
      setContentScrollHandler?: (handler: ((data: string) => boolean) | undefined) => () => void
    }
    const dispose = screen.setContentScrollHandler?.(data => {
      if (!extensionRuntime.focused) return false
      /* v8 ignore start -- exercised by the real PTY and mouse path */
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
      /* v8 ignore stop */
      /* v8 ignore start -- exercised by the real PTY and mouse path */
      const pageUp = ctx.mayflyKeymap.matches(data, ACTION_PAGE_UP)
      const pageDown = ctx.mayflyKeymap.matches(data, ACTION_PAGE_DOWN)
      if (pageUp || pageDown) {
        const direction = pageUp ? 'up' : 'down'
        const amount = Math.max(1, ctx.mayflyScreen.rows - 4)
        return ctx.mayflyScreen.scrollContent(direction, amount)
      }
      if (editor.getText().length > 0) return false
      if (ctx.mayflyKeymap.matches(data, ACTION_END)) {
        ctx.mayflyScreen.followContent()
        setNotice('')
        return true
      }
      /* v8 ignore stop */
      return false
    })
    return () => dispose?.()
  })
  /* v8 ignore start -- notification is driven by live streaming events */
  ctx.effect(() => ctx.on('mayfly/transcript-content-changed', paused => {
    if (paused) setNotice('new messages available · press End to follow')
  }))
  /* v8 ignore stop */
}
