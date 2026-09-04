/**
 * `mayfly-pane-btw` plugin: the `/btw` side-question view. `/btw <question>`
 * forks the live session into a throwaway side session through the native
 * Harness `agents` service, posts the question as a follow-up, and renders
 * the exchange from the native `sessionProjections` service.
 *
 * The view mounts into the editor slot through `mayflyEditorPanels` (the
 * editor-slot swap, same as the `/agents` attach view): it owns its whole
 * frame — a `╭ BTW ╮` top rule, `│`-framed body rows, an inline follow-up
 * prompt, and a guidance row — and its own height (half the screen), so no
 * dock allocation or editor splice is involved. The follow-up prompt is a
 * plain buffer: Enter posts a continuation to the same side agent, Esc (or
 * `q` on an empty buffer) closes, Ctrl+C clears the draft, and the arrow
 * keys scroll the exchange. Esc and the arrows resolve through
 * `mayflyKeymap`, so kitty CSI-u and modifyOtherKeys encodings close and
 * scroll exactly like their legacy byte forms. The fork, watermark,
 * follow-up, and disposal logic is renderer-independent and unchanged by
 * the view shell.
 *
 * `/btw` without input dismisses the view and disposes the side agent; a
 * new question while one is open disposes the previous side agent first
 * (single slot). Creation is async and the fiber may unload mid-flight
 * (theme swap): an `unloaded` flag armed by an effect disposer makes the
 * continuation dispose the fresh handle instead of publishing it, and
 * unloading also disposes the live slot and unmounts the view.
 *
 * @module @ephemeral-ai/mayfly/transcript/pane-btw
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyScreen, MayflySemanticColors } from '../core/index.ts'
import { ACTION_CANCEL, ACTION_MOVE_DOWN, ACTION_MOVE_UP } from '../interaction/keys.ts'
import type { ConversationProjection } from '../conversation/index.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-pane-btw'

/** Services required before the view and command can register. */
export const inject = ['commands', 'mayflyCurrentAgent', 'agents', 'agentDefaultModel', 'agentPresets', 'sessionProjections']

/** One question/answer exchange inside the view. */
interface BtwTurn {
  /** The question that started this exchange. */
  question: string
  /** The accumulated (then finalized) side reply text. */
  reply: string
  /** Whether the side agent has yet to return to idle for this turn. */
  thinking: boolean
  /** Projection sequence already present before this question was posted. */
  afterSeq: number
}

/** The live side session plus its projection/status subscription unbinders. */
interface BtwSlot {
  handle: AgentHandle
  unbind: () => void
}

interface ProjectionSource {
  snapshot(session: Session): { readonly asOfSeq: number, readonly values: Record<string, unknown> }
  onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void): () => void
}

const BTW_MIN_WIDTH = 5
const BTW_MIN_BODY_LINES = 3
const BTW_HEIGHT_FRACTION = 2
const KEY_PAGE_UP = '\x1b[5~'
const KEY_PAGE_DOWN = '\x1b[6~'

function projectionReply(value: unknown, afterSeq: number): { reply: string, thinking: boolean } {
  if (value === null || typeof value !== 'object') return { reply: '', thinking: false }
  const row = value as { readonly entries?: unknown, readonly streaming?: unknown }
  if (!Array.isArray(row.entries)) return { reply: '', thinking: false }
  const projection = row as ConversationProjection
  const assistant = [...projection.entries].reverse().find(entry => typeof entry === 'object'
    && entry !== null
    && entry.kind === 'assistant'
    && entry.seq > afterSeq)
  return {
    reply: assistant?.kind === 'assistant' ? assistant.text : '',
    thinking: projection.streaming === true,
  }
}

/** Dependencies the view borrows from the plugin and the display services. */
export interface BtwViewOptions {
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  /** Keybinding truth: normalizes the kitty/modifyOtherKeys escape and arrow encodings. */
  readonly keymap: MayflyKeymap
  /** Live turn list owned by the plugin. */
  readonly turns: () => readonly BtwTurn[]
  /** Whether the side agent is still answering the latest turn. */
  readonly busy: () => boolean
  /** Post one follow-up question to the live side agent. */
  readonly onSubmit: (text: string) => void
  /** Dismiss the view and dispose the side agent. */
  readonly onClose: () => void
}

/**
 * Framed side-question exchange with an inline follow-up prompt, in the
 * `ChildAttachView` shape: the view owns the frame and its height budget, so
 * nothing outside it can clip or restyle the box.
 */
export class BtwView implements MayflyFocusable {
  focused = false
  private buffer = ''
  private scrollOffset = 0
  private bodyTotal = 0
  private disposed = false

  constructor(private readonly options: BtwViewOptions) {}

  /** Release the view; later input and renders are inert. */
  dispose(): void {
    this.disposed = true
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // Ctrl+C clears the draft; the fork handle exposes no native interrupt.
    if (data === '\x03') {
      if (this.buffer !== '') {
        this.buffer = ''
        this.invalidate()
      }
      return
    }
    // Escape and the arrows resolve through the keymap, which normalizes the
    // kitty CSI-u and modifyOtherKeys encodings a plain '\x1b' comparison
    // would miss (the user's terminal may report Esc as `\x1b[27u`).
    const { keymap } = this.options
    if (keymap.matches(data, ACTION_CANCEL) || (data === 'q' && this.buffer === '')) {
      this.options.onClose()
      return
    }
    if (keymap.matches(data, ACTION_MOVE_UP) || keymap.matches(data, ACTION_MOVE_DOWN)) {
      this.scrollBy(keymap.matches(data, ACTION_MOVE_UP) ? 1 : -1)
      return
    }
    if (data === KEY_PAGE_UP || data === KEY_PAGE_DOWN) {
      this.scrollBy((data === KEY_PAGE_UP ? 1 : -1) * Math.max(1, this.bodyBudget() - 1))
      return
    }
    if (data === '\r') {
      const text = this.buffer.trim()
      if (text === '' || this.options.busy()) return
      this.buffer = ''
      this.options.onSubmit(text)
      this.invalidate()
      return
    }
    if (data === '\x7f') {
      this.buffer = this.buffer.slice(0, -1)
      this.invalidate()
      return
    }
    if (data.startsWith('\x1b') || /[\x00-\x1f\x7f]/.test(data)) return
    this.buffer += data
    this.invalidate()
  }

  invalidate(): void {
    if (!this.disposed) this.options.screen.requestRender()
  }

  render(width: number): string[] {
    if (this.disposed || width < BTW_MIN_WIDTH) return []
    const { colors, components } = this.options
    const contentWidth = Math.max(1, width - 4)
    const status = this.options.busy() ? '● running' : '○ idle'
    const lines = [components.topRule(width, {
      title: colors.primary(' BTW '),
      hint: colors.textMuted(`${status} `),
      paint: colors.border,
    })]
    const all = this.bodyLines(contentWidth)
    if (this.scrollOffset > 0 && all.length > this.bodyTotal) this.scrollOffset += all.length - this.bodyTotal
    this.bodyTotal = all.length
    const budget = this.bodyBudget()
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, all.length - budget))
    const end = all.length - this.scrollOffset
    const body = all.slice(Math.max(0, end - budget), end)
    while (body.length < budget) body.push('')
    for (const line of body) lines.push(this.frame(line, contentWidth))
    const placeholder = this.buffer === '' ? colors.muted(' Ask a follow-up…') : ''
    lines.push(this.frame(`${colors.roleUser('› ')}${this.buffer}▌${placeholder}`, contentWidth))
    lines.push(this.frame(colors.textMuted('Enter follow up · Esc close'), contentWidth))
    return lines
  }

  /** The exchange rows: question, reply, and the waiting loader per turn. */
  private bodyLines(width: number): string[] {
    const { colors, components } = this.options
    const rows: string[] = []
    for (const [index, turn] of this.options.turns().entries()) {
      if (index > 0) rows.push('')
      rows.push(...components.wrapText(`\x1b[1m${colors.accent(`> ${turn.question}`)}\x1b[22m`, width))
      if (turn.reply !== '') rows.push(...components.wrapText(turn.reply, width))
      // kimi parity: the waiting loader yields to the answer text as soon as
      // the first reply bytes land; it never trails a partial answer.
      else if (turn.thinking) rows.push(colors.muted('thinking...'))
    }
    return rows
  }

  private bodyBudget(): number {
    const rows = this.options.screen.rows
    if (!Number.isFinite(rows) || rows <= 0) return BTW_MIN_BODY_LINES
    return Math.max(BTW_MIN_BODY_LINES, Math.floor(rows / BTW_HEIGHT_FRACTION) - 2)
  }

  private scrollBy(delta: number): void {
    const maxOffset = Math.max(0, this.bodyTotal - this.bodyBudget())
    const next = Math.min(maxOffset, Math.max(0, this.scrollOffset + delta))
    if (next === this.scrollOffset) return
    this.scrollOffset = next
    this.invalidate()
  }

  private frame(line: string, width: number): string {
    const { colors, components } = this.options
    const clipped = components.truncateToWidth(line, width, '…')
    const padding = Math.max(0, width - components.visibleWidth(clipped))
    return colors.border('│') + ' ' + clipped + ' '.repeat(padding) + ' ' + colors.border('│')
  }
}

/**
 * Mount the side-question view and register `/btw`. The command handler owns
 * the whole lifecycle: validate the target session, replace the previous
 * slot, create the seeded side agent, subscribe its session's event feed and
 * status, then post the question as a follow-up. Every registration is
 * effect-bound; unloading the fiber unregisters the command, unmounts the
 * view, disposes the live side agent, and arms the in-flight-creation guard.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const turns: BtwTurn[] = []
  let slot: BtwSlot | undefined
  let view: BtwView | undefined
  let unmount: (() => void) | undefined
  let unloaded = false
  const projections = ctx.sessionProjections as ProjectionSource

  const busy = (): boolean => turns.at(-1)?.thinking === true
  const refresh = (): void => { view?.invalidate() }

  /** Unmount and dispose the live view, if any. */
  const closeView = (): void => {
    const current = view
    const unmountCurrent = unmount
    view = undefined
    unmount = undefined
    current?.dispose()
    unmountCurrent?.()
  }

  /** Unsubscribe and dispose the live side agent, if any. */
  const clearSlot = async (): Promise<void> => {
    const current = slot
    slot = undefined
    if (current === undefined) return
    current.unbind()
    await current.handle.dispose()
  }

  /** Close the view and dispose the side agent. */
  const dismiss = async (): Promise<CommandResult> => {
    if (view === undefined) return { kind: 'error', text: 'no side question is open' }
    // Unmount before disposal: disposing a running side agent stops its loop
    // and awaits its exit, which must never hold the panel on screen.
    closeView()
    turns.length = 0
    await clearSlot()
    return { kind: 'success', text: 'dismissed the side question' }
  }

  /** Post one continuation question to the live side agent. */
  const submitFollowup = (text: string): void => {
    const current = slot
    /* c8 ignore next -- the view refuses Enter while busy, and an idle open
       view always holds its slot; this guard protects a hostile host. */
    if (current === undefined || busy()) return
    const snapshot = projections.snapshot(current.handle.agent.session)
    turns.push({
      question: text,
      reply: '',
      thinking: true,
      afterSeq: snapshot.asOfSeq,
    })
    current.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    refresh()
  }

  const ask = async (question: string): Promise<CommandResult> => {
    if (question === '') return dismiss()
    if (view === undefined) {
      const screen = ctx.get('mayflyScreen')
      const components = ctx.get('mayflyComponents')
      const theme = ctx.get('mayflyTheme')
      const panels = ctx.get('mayflyEditorPanels')
      const keymap = ctx.get('mayflyKeymap')
      if (screen === undefined || components === undefined || theme === undefined || panels === undefined || keymap === undefined) {
        return { kind: 'error', text: 'btw panel is unavailable: the Mayfly screen is not mounted' }
      }
      view = new BtwView({
        screen,
        components,
        colors: theme.colors,
        keymap,
        turns: () => turns,
        busy,
        onSubmit: submitFollowup,
        // The view is already unmounted before disposal runs; a disposal
        // failure must not become an unhandled rejection from a key press.
        onClose: () => { void dismiss().catch(() => {}) },
      })
      unmount = panels.mount(view)
    }
    // Replace the visible turn before either disposal or side creation can
    // yield. The fork may take long enough to otherwise leave the previous
    // answer painted as if it belonged to this question.
    turns.length = 0
    turns.push({ question, reply: '', thinking: true, afterSeq: Number.MAX_SAFE_INTEGER })
    refresh()
    // Single slot: a fresh question replaces the previous side agent.
    await clearSlot()
    let handle: AgentHandle | undefined
    try {
      const parent = ctx.mayflyCurrentAgent.current()
      if (parent !== null) {
        const seed = parent.session.snapshotEvents()
        const selected = parent.session.requestHeader()?.config ?? ctx.agentDefaultModel.currentSelection()
        let preset = parent.session.header.agentPreset
        for (const event of seed) {
          if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
        }
        handle = await ctx.agents.create({
          sessionId: SessionId(`btw-${randomUUID()}`),
          meta: {
            cwd: parent.session.header.cwd ?? process.cwd(),
            parentSession: parent.id,
            ...(seed.length === 0 ? {} : { isSeeded: true }),
          },
          ...(seed.length === 0 ? {} : { inheritedEventCount: SessionLogOffset(seed.length) }),
          seed,
          agentOptions: {
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
        })
      }
    } catch (error) {
      closeView()
      turns.length = 0
      return {
        kind: 'error',
        text: `could not start the side session: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (handle === undefined) {
      closeView()
      turns.length = 0
      return { kind: 'error', text: 'no active session for a side question' }
    }
    // The fiber may have unloaded (e.g. a theme swap) while creation was in
    // flight: dispose the fresh handle instead of publishing a dead view.
    if (unloaded) {
      await handle.dispose()
      return { kind: 'error', text: 'the side-question plugin was unloaded' }
    }
    const updateFromProjection = (value: unknown): void => {
      const turn = turns.at(-1)
      /* c8 ignore next -- ask seeds the first turn before any projection callback is bound. */
      if (turn === undefined) return
      const next = projectionReply(value, turn.afterSeq)
      const thinking = next.thinking || turn.thinking
      if (turn.reply === next.reply && turn.thinking === thinking) return
      turn.reply = next.reply
      turn.thinking = thinking
      refresh()
    }
    // The fork snapshot contains the parent conversation. Its watermark is
    // the hard boundary between inherited history and this question.
    const initialSnapshot = projections.snapshot(handle.agent.session)
    turns[0]!.afterSeq = initialSnapshot.asOfSeq
    updateFromProjection(initialSnapshot.values['mayflyConversation'])
    const offProjection = projections.onChanged((session, key, value) => {
      if (session !== handle.agent.session || key !== 'mayflyConversation') return
      updateFromProjection(value)
    })
    const updateStatus = (status: string): void => {
      const turn = turns.at(-1)
      /* v8 ignore next -- an open slot always seeds one turn before status
         subscription; this guard protects a hostile host callback. */
      if (turn === undefined) return
      const thinking = status === 'running'
      if (turn.thinking === thinking) return
      turn.thinking = thinking
      refresh()
    }
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (agent === handle.agent) updateStatus(status)
    })
    updateStatus(handle.agent.status)
    slot = {
      handle,
      unbind: () => {
        offProjection()
        offStatus()
      },
    }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } }))
    refresh()
    return { kind: 'success', text: 'asked the side question' }
  }

  // Effect-bound so unloading this fiber unregisters the command.
  ctx.effect(() => ctx.commands.register({
    name: 'btw',
    description: 'Ask a side question in a forked session',
    input: { hint: '<question>' },
    handler: invocation => ask(invocation.rawInput.trim()),
  }))

  // Disposers may be async and are awaited: unload disposes the side agent,
  // unmounts the view (idempotent), and arms the guard any in-flight
  // creation checks before publishing.
  ctx.effect(() => async () => {
    unloaded = true
    closeView()
    await clearSlot()
  })
}
