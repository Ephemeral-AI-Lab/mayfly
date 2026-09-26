/**
 * Transcript components: self-contained `MayflyComponent` implementations over
 * the `mayflyComponents` factory (`ctx.mayflyComponents`). None of them imports
 * pi-tui — `render(width)` returns styled ANSI lines within `width` visible
 * columns. The assistant body is a held `MayflyMarkdown` instance (created
 * once, streamed via `setText`, with a bounded plain-text tail for oversized
 * live output); the remaining components wrap/truncate through the factory's width helpers and cache by
 * (source text, width) so the screen's throttled redraws stay cheap while a
 * `TranscriptItem` mutates underneath.
 *
 * @module @ephemeral-ai/mayfly/transcript/components
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  MayflyComponent,
  MayflyComponents,
  MayflyImage,
  MayflyMarkdown,
  MayflySemanticColors,
} from '../core/index.ts'
import { sanitizePluginText } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { extractKeyArgument, isPlanDecline, KEY_ARG_MAX_CHARS } from './present.ts'
import { summarizeToolText } from './envelope.ts'
import { moreLinesHint, moreOutputHint } from './hints.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { prettyJson, toolDisplayName } from './tool-line.ts'
import {
  DEFAULT_USER_FOLD_CHARS,
  DEFAULT_USER_FOLD_LINES,
  DEFAULT_TRANSCRIPT_PRESENTATION,
  type TranscriptPresentationSnapshot,
} from './presentation-policy.ts'
import type {
  TranscriptAssistantItem,
  TranscriptToolItem,
  TranscriptToolResult,
  TranscriptUserItem,
} from './types.ts'

/** Maximum length of the tool-call arguments shown on the call line. */
export const TOOL_ARGUMENTS_MAX_CHARS = KEY_ARG_MAX_CHARS

/** Collapsed result preview: visual rows kept (kimi `RESULT_PREVIEW_LINES`). */
export const RESULT_PREVIEW_LINES = 3

/** Collapsed Write/Edit-style preview: rows kept (kimi `COMMAND_PREVIEW_LINES`). */
export const COMMAND_PREVIEW_LINES = 10

/** Collapsed long user-message preview: visual rows kept (the S20 idiom, D46). */
export const USER_PREVIEW_LINES = 3

/** Maximum source characters formatted synchronously for one live stream. */
export const STREAMING_RENDER_MAX_CHARS = 32_000

/** Maximum source characters inspected for a collapsed raw tool preview. */
export const TOOL_PREVIEW_SCAN_MAX_CHARS = 32_000

/** Maximum synchronous rows emitted by an expanded raw result. */
export const TOOL_EXPANDED_RENDER_LINES = 200

/**
 * Default raw-line count above which a user message folds. Mirrors the
 * pi-tui editor's paste-fold line ("> 10 lines") so what folds in the
 * editor folds in the transcript echo too (D46).
 */
export { DEFAULT_USER_FOLD_LINES }

/**
 * Default raw character count above which a user message folds — the
 * pi-tui editor's second paste-fold criterion ("> 1000 characters"), so a
 * single long line (a big one-line JSON, say) folds as well.
 */
export { DEFAULT_USER_FOLD_CHARS }

/** Indent of the collapsed/expanded result preview rows (kimi's default). */
const PREVIEW_INDENT = '  '

/** The assistant block's first-line marker (kimi `constant/symbols.ts`). */
const STATUS_BULLET = '● '

/** The user block's first-line marker (the DeepSeek guide arrow). */
export const USER_MESSAGE_BULLET = '» '

/** Continuation indent: the bullet's visible width (kimi `MESSAGE_INDENT`). */
export const MESSAGE_INDENT = '  '

/** Maximum rendered height of one user-message image, in terminal cells. */
export const USER_IMAGE_MAX_HEIGHT_CELLS = 12

/**
 * Loads one image attachment's bytes. Resolves `undefined` when the bytes
 * are unavailable (missing store, read failure) — the placeholder stays.
 */
export type UserImageLoader = (ref: ImageAttachmentRef) => Promise<Uint8Array | undefined>

/** Optional image-rendering wiring for {@link UserMessageComponent}. */
export interface UserMessageImages {
  /** The attachment byte loader; absent loaders keep the `[image]` rows. */
  loadImage?: UserImageLoader
  /** Nudge called after an image resolves so the screen re-renders. */
  onReady?(): void
  /** Tree-scoped policy getter; omitted consumers use shipped defaults. */
  presentation?: () => TranscriptPresentationSnapshot
  /** Dynamic translator for transcript-owned chrome. */
  t?: MayflyTranslate
}

/** Cache keyed on the inputs a component's rendered lines depend on. */
interface RenderCache {
  key: string
  lines: string[]
}

/** Keep live rendering bounded while retaining the complete model for history. */
function streamingWindow(text: string): string {
  const start = text.length - STREAMING_RENDER_MAX_CHARS
  const boundary = text.indexOf('\n', start)
  const visible = sanitizePluginText(text.slice(boundary < 0 ? start : boundary + 1))
  return `... (${String(text.length - visible.length)} earlier characters)\n${visible}`
}

/** Wrap only the prefix needed by a collapsed preview. */
function boundedPreview(text: string, width: number, rows: number, components: MayflyComponents): { readonly lines: string[], readonly more: boolean, readonly remaining?: number, readonly total?: number } {
  const sample = text.length > TOOL_PREVIEW_SCAN_MAX_CHARS ? text.slice(0, TOOL_PREVIEW_SCAN_MAX_CHARS) : text
  const wrapped = components.wrapText(sample, width)
  const complete = sample.length === text.length
  return {
    lines: wrapped.slice(0, rows),
    more: !complete || wrapped.length > rows,
    ...(complete && wrapped.length > rows ? { remaining: wrapped.length - rows, total: wrapped.length } : {}),
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  let count = 1
  for (const character of text) if (character === '\n') count += 1
  return text.endsWith('\n') ? count - 1 : count
}

/**
 * Renders one user prompt behind the DeepSeek user-message chrome (S18): a
 * blank separator row, then the bold `roleUser` `» ` bullet on the first
 * line with the full text bold `roleUser` — the kimi `boldFg('roleUser', …)`
 * wrap, composed here as bold SGR around the palette color, so the visible
 * width never changes. Continuations align under the text with spaces of
 * the bullet's visible width (kimi re-dyes the text before wrapping; Mayfly
 * colors each wrapped line, which re-emits the same per-line spans). When
 * the item carries image attachments and a loader was provided, loads kick
 * off lazily on the first render; each image renders its loaded lines
 * below the text at the content width, indented to the same bullet width
 * (a muted `[image]` row while loading or after failure), and a resolve
 * bumps the cache version, invalidates, and nudges `onReady`.
 *
 * A long message (raw metrics over the original text — the pi-tui editor
 * paste-fold thresholds, >10 lines or >1000 characters — never wrap
 * width) renders collapsed (D46): the first {@link USER_PREVIEW_LINES}
 * wrapped lines plus the dim `ctrl+o` hint row, the S20 tool-card idiom.
 * The fold stays component-local so the fold layer stays pure/width-free
 * and replay converges for free (D16); `setExpanded` joins the global
 * Ctrl-O toggle, and raw metrics mean a resize never refolds an expanded
 * message.
 */
export class UserMessageComponent implements MayflyComponent {
  private readonly item: TranscriptUserItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly loadImage: UserImageLoader | undefined
  private readonly onReady: (() => void) | undefined
  private readonly presentation: () => TranscriptPresentationSnapshot
  private readonly t: MayflyTranslate
  /** Per-image outcome: the image component, null for a failed load. */
  private readonly resolved = new Map<number, MayflyImage | null>()
  private imageVersion = 0
  private expanded = false
  private keyed = true
  private cache: RenderCache | null = null

  /**
   * @param item - the folded user item to render.
   * @param colors - the semantic color table.
   * @param components - the component factory providing the width helpers.
   * @param images - optional image loader and readiness nudge.
   */
  constructor(
    item: TranscriptUserItem,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    images: UserMessageImages = {},
  ) {
    this.item = item
    this.colors = colors
    this.components = components
    this.loadImage = images.loadImage
    this.onReady = images.onReady
    this.presentation = images.presentation ?? (() => DEFAULT_TRANSCRIPT_PRESENTATION)
    this.t = images.t ?? interpolateLocaleMessage
    if (this.loadImage !== undefined && (item.images ?? []).length > 0) this.requestImages(this.loadImage)
  }

  /** Drop the cached lines; the next render rebuilds from the item. */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Switch a foldable message between the collapsed preview and the full
   * text. The expansion flag joins the render cache key, so the next
   * render rebuilds without an explicit invalidate (the ToolCall
   * precedent); short messages ignore the flag — nothing is hidden.
   * @param expanded - true renders every wrapped line, false the preview.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  /** Adopt whether Ctrl-O reaches the message, so the fold hint may name the key. */
  setScope(scope: { readonly hint: boolean }): void {
    this.keyed = scope.hint
  }

  /** Whether the raw-text metrics put this message over a fold threshold. */
  private isFoldable(): boolean {
    const policy = this.presentation()
    return this.item.text.split('\n').length > policy.userFoldLines || this.item.text.length > policy.userFoldChars
  }

  /** Kick off all image loads once; each settle stores its outcome. */
  private requestImages(load: UserImageLoader): void {
    for (const [index, ref] of this.item.images.entries()) {
      const settle = (data: Uint8Array | undefined): void => {
        this.resolved.set(index, data === undefined
          ? null
          : this.components.createImage({
            data,
            mediaType: ref.mediaType,
            ...(ref.name === undefined ? {} : { filename: sanitizePluginText(ref.name).replace(/[\r\n]+/gu, ' ') }),
            maxHeightCells: USER_IMAGE_MAX_HEIGHT_CELLS,
          }))
        this.imageVersion += 1
        this.invalidate()
        this.onReady?.()
      }
      void load(ref).then(settle, () => settle(undefined))
    }
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows.
   */
  render(width: number): string[] {
    const text = sanitizePluginText(this.item.text)
    const key = `${this.item.seq}:${width}:${this.imageVersion}:${this.expanded}:${this.keyed}:${text}`
    if (this.cache?.key === key) return this.cache.lines
    const bullet = this.components.strong(this.colors.roleUser(USER_MESSAGE_BULLET))
    const bulletWidth = this.components.visibleWidth(USER_MESSAGE_BULLET)
    const contentWidth = Math.max(1, width - bulletWidth)
    const wrapped = this.components.wrapText(text, contentWidth)
    const bold = (text: string): string => this.components.strong(this.colors.roleUser(text))
    const indent = ' '.repeat(bulletWidth)
    // The fold gates on `expanded`, never on the wrapped count: a resize
    // changes wrapping but never refolds an expanded message back.
    const folded = !this.expanded && this.isFoldable()
    const shown = folded ? wrapped.slice(0, USER_PREVIEW_LINES) : wrapped
    let lines = ['', ...shown.map((line, index) =>
      (index === 0 ? bullet : indent) + bold(line))]
    if (folded && wrapped.length > shown.length) {
      // The S20 expand hint, width-disciplined to the content indent.
      const remaining = wrapped.length - shown.length
      const hint = moreLinesHint(this.t, remaining, wrapped.length, this.keyed)
      lines.push(indent + this.colors.textMuted(this.components.truncateToWidth(hint, contentWidth)))
    }
    const images = this.item.images ?? []
    if (images.length > 0) {
      for (let index = 0; index < images.length; index += 1) {
        const image = this.resolved.get(index)
        if (image) lines.push(...image.render(contentWidth).map(line => indent + line))
        else lines.push(`${indent}${this.colors.muted(this.t('[image]'))}`)
      }
    }
    // The bullet can out wide a degenerate viewport (a resize drag crossing
    // three columns); every assembled row passes the width backstop.
    lines = lines.map(text => this.components.truncateToWidth(text, width))
    this.cache = { key, lines }
    return lines
  }
}

/**
 * Renders one assistant step's visible Markdown body behind the kimi
 * message chrome: a blank separator row, then the `text`-colored `● `
 * bullet on the first line with every continuation indented by the
 * bullet's visible width — the S18 assistant half, pulled into the S17
 * dogfood by the user's margin ruling. The markdown renders at the
 * content width (viewport minus the bullet), so its horizontal rules span
 * exactly the body text. The step's reasoning renders in its own sibling
 * `ThinkingComponent` (`src/thinking.ts`) mounted above this block. There
 * is no streaming marker: kimi renders growing text bare, and the Mayfly
 * `▌` cursor retired with the S17 third dogfood ruling — the activity
 * pane's composing row is the signal. The body is a held `MayflyMarkdown`
 * whose own text/width cache replaces the former hand-rolled Markdown
 * cache; mid-stream unterminated constructs settle as the text completes,
 * including closed Mermaid fences rendered by core's rich document adapter.
 */
export class AssistantMessageComponent implements MayflyComponent {
  private readonly item: TranscriptAssistantItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly markdown: MayflyMarkdown
  private cache: RenderCache | null = null

  /**
   * @param item - the folded assistant item; mutated by the fold as the
   *   step streams and finalizes.
   * @param colors - the semantic color table (the bullet carries `text`).
   * @param components - the component factory; creates the held Markdown.
   */
  constructor(item: TranscriptAssistantItem, colors: MayflySemanticColors, components: MayflyComponents) {
    this.item = item
    this.colors = colors
    this.components = components
    this.markdown = components.createMarkdown({ text: '' })
  }

  /** Drop the cached lines; the next render rebuilds from the item. */
  invalidate(): void {
    this.cache = null
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows.
   */
  render(width: number): string[] {
    const streaming = this.item.streaming === true
    const text = this.item.text.length > STREAMING_RENDER_MAX_CHARS
      ? streamingWindow(this.item.text)
      : sanitizePluginText(this.item.text)
    const key = `${width}:${streaming}:${text}`
    if (this.cache?.key === key) return this.cache.lines

    const lines: string[] = ['']
    if (text.trim()) {
      const contentWidth = Math.max(1, width - this.components.visibleWidth(STATUS_BULLET))
      const content = this.item.text.length > STREAMING_RENDER_MAX_CHARS
        ? this.components.wrapText(text, contentWidth)
        : (() => {
            this.markdown.setText(text)
            return this.markdown.render(contentWidth)
          })()
      lines.push(...content.map((line, index) =>
        (index === 0 ? this.colors.text(STATUS_BULLET) : MESSAGE_INDENT) + line))
    }
    const clamped = lines.map(text => this.components.truncateToWidth(text, width))
    this.cache = { key, lines: clamped }
    return clamped
  }
}

/**
 * Renders one tool call card: a status marker, a header, and a body.
 *
 * - The marker is the solid `●` while running (`⊘` once its turn ended
 *   without a result), `✓` on success, `✗` on failure (a tool error, or a
 *   command exiting non-zero or by signal), and `◐` for a declined plan.
 * - A terminal call's header is `$ command` with an exit/signal pill and its
 *   run time; its body is the description over the output's last
 *   {@link RESULT_PREVIEW_LINES} rows.
 * - A presenter-backed call's header is the presenter's own call title (with
 *   the diff `+A −D` chip); its body is the presented result.
 * - A presenter-less call keeps the `Using/Used name (key arg)` header (MCP
 *   names read `server › tool`) with a line-count chip, and its raw result
 *   preview; bash without a presenter keeps the `$ command` preview.
 *
 * Ctrl-O expands the body; hints name the key only when Ctrl-O reaches the
 * card's turn. Presenter-less JSON results pretty-print when expanded.
 */
export class ToolCallComponent implements MayflyComponent {
  private item: TranscriptToolItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly t: MayflyTranslate
  private expanded = false
  private keyed = true
  private closed = false
  private cache: RenderCache | null = null

  /**
   * @param item - the folded tool item; `result` appears when the paired
   *   `tool/result` folds in.
   * @param colors - the semantic color table.
   * @param components - the component factory providing the width helpers.
   * @param presentedBody - the presenter-backed body, when the tool declares views.
   * @param resultChip - the semantic header chip (a diff's `+A −D`).
   * @param t - transcript translator.
   */
  constructor(
    item: TranscriptToolItem,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    private readonly presentedBody?: MayflyComponent & { setExpanded?(expanded: boolean): void, setScope?(scope: { readonly hint: boolean }): void },
    private resultChip?: string,
    t: MayflyTranslate = interpolateLocaleMessage,
  ) {
    this.item = item
    this.colors = colors
    this.components = components
    this.t = t
  }

  /** Drop the cached lines; the next render rebuilds from the item. */
  invalidate(): void {
    this.cache = null
    this.presentedBody?.invalidate()
  }

  /**
   * Switch the result block between the collapsed preview and the full tool
   * output. The expansion flag joins the render cache key, so the next
   * render rebuilds without an explicit invalidate.
   * @param expanded - true renders every wrapped line, false the preview.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.presentedBody?.setExpanded?.(expanded)
  }

  /** Adopt whether Ctrl-O reaches the card and whether its turn has ended. */
  setScope(scope: { readonly hint: boolean, readonly turnClosed: boolean }): void {
    this.keyed = scope.hint
    this.closed = scope.turnClosed
    this.presentedBody?.setScope?.(scope)
  }

  /** Replace the semantic result summary after a pending tool settles. */
  setResultChip(resultChip: string | undefined): void {
    if (this.resultChip === resultChip) return
    this.resultChip = resultChip
    this.invalidate()
  }

  /** Replace one projected tool snapshot while preserving component identity. */
  update(item: TranscriptToolItem, resultChip: string | undefined): void {
    this.item = item
    this.resultChip = resultChip
    this.invalidate()
  }

  /** The exit/signal failure of a settled terminal run, or `undefined`. */
  private exitFailure(): string | undefined {
    const terminal = this.item.terminal
    if (terminal?.signal !== undefined) return `signal ${terminal.signal}`
    return terminal?.exitCode === undefined || terminal.exitCode === 0 ? undefined : `exit ${String(terminal.exitCode)}`
  }

  /** The header row: marker, label, chips. */
  private renderHeader(width: number): string {
    const { result, terminal } = this.item
    const { colors, components } = this
    const flat = (text: string): string => sanitizePluginText(text).replace(/[\r\n]+/gu, ' ')
    const declined = result !== undefined && isPlanDecline(this.item)
    const failure = this.exitFailure()
    const cancelled = result === undefined && this.closed
    const bullet = result === undefined
      ? cancelled ? colors.muted('⊘ ') : colors.text(STATUS_BULLET)
      : declined
        ? colors.warning('◐ ')
        : result.isError || failure !== undefined
          ? colors.error('✗ ')
          : colors.success('✓ ')
    let header: string
    if (terminal !== undefined) {
      header = `${bullet}${colors.shellMode('$ ')}${components.strong(colors.primary(flat(terminal.command)))}`
      if (failure !== undefined) header += colors.error(` · ${failure}`)
      const elapsed = result === undefined ? 0 : result.endedAt - this.item.startedAt
      if (elapsed >= 1000) header += colors.muted(` · ${compactElapsedMs(elapsed)}`)
    } else if (this.item.title !== undefined) {
      header = `${bullet}${components.strong(colors.primary(flat(this.item.title)))}`
      if (!declined && result !== undefined && this.resultChip !== undefined) {
        header += result.isError ? colors.error(` · ${this.resultChip}`) : colors.muted(` · ${this.resultChip}`)
      }
    } else {
      const toolName = flat(this.item.name)
      if (toolName === 'bash') {
        // The body's `$ command` preview carries the command itself.
        header = `${bullet}${components.strong(colors.primary(result === undefined ? 'Running a command' : 'Ran a command'))}`
      } else {
        const name = components.strong(colors.primary(toolDisplayName(toolName)))
        header = `${bullet}${result === undefined ? 'Using' : 'Used'} ${name}`
        const keyArg = extractKeyArgument(this.item)
        if (keyArg !== undefined) header += colors.muted(` (${flat(keyArg)})`)
      }
      if (!declined && result !== undefined) {
        const count = lineCount(sanitizePluginText(result.fullText ?? result.text))
        const chip = this.resultChip ?? (count > 0 ? `${count} ${count === 1 ? 'line' : 'lines'}` : undefined)
        if (chip !== undefined) header += result.isError ? colors.error(` · ${chip}`) : colors.muted(` · ${chip}`)
      }
    }
    if (declined) header += colors.warning(' · plan declined')
    if (cancelled) header += colors.muted(` · ${this.t('cancelled')}`)
    return components.truncateToWidth(header, width)
  }

  /** The bash fallback's command lines, or undefined for a non-bash card. */
  private commandPreview(): string[] | undefined {
    if (this.item.name !== 'bash') return undefined
    const parsed = this.item.parsedArguments
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
    const command = (parsed as Record<string, unknown>)['command']
    if (typeof command !== 'string' || command === '') return undefined
    return sanitizePluginText(command).split('\n')
  }

  /** The hint row under a folded body, indented to the body. */
  private hintRow(width: number, remaining: number | undefined, total: number | undefined): string {
    const hint = remaining === undefined ? moreOutputHint(this.t, this.keyed) : moreLinesHint(this.t, remaining, total, this.keyed)
    return this.components.truncateToWidth(`${PREVIEW_INDENT}${this.colors.textMuted(hint)}`, width)
  }

  /** A terminal card's body: the description over the output tail (all of it when expanded). */
  private renderTerminal(width: number, result: TranscriptToolResult | undefined): string[] {
    const { colors, components } = this
    const terminal = this.item.terminal!
    const lines: string[] = []
    const contentWidth = Math.max(1, width - components.visibleWidth(PREVIEW_INDENT))
    if (terminal.description !== undefined && terminal.description.trim() !== '') {
      lines.push(components.truncateToWidth(`${PREVIEW_INDENT}${colors.muted(sanitizePluginText(terminal.description).replace(/[\r\n]+/gu, ' '))}`, width))
    }
    if (this.expanded) {
      const command = sanitizePluginText(terminal.command).split('\n')
      if (command.length > 1) command.forEach((line, index) => lines.push(components.truncateToWidth(`${PREVIEW_INDENT}${index === 0 ? colors.shellMode('$ ') : '  '}${colors.muted(line)}`, width)))
    }
    if (result === undefined) return lines
    const output = sanitizePluginText(terminal.output ?? result.fullText ?? result.text).replace(/\n+$/, '')
    if (output.trim() === '') {
      lines.push(`${PREVIEW_INDENT}${colors.textMuted(this.t('(no output)'))}`)
      return lines
    }
    const paint = (line: string): string => `${PREVIEW_INDENT}${result.isError ? colors.error(line) : colors.muted(line)}`
    if (this.expanded) {
      const preview = boundedPreview(output, contentWidth, TOOL_EXPANDED_RENDER_LINES, components)
      lines.push(...preview.lines.map(paint))
      if (preview.more) lines.push(this.hintRow(width, preview.remaining, preview.total))
      return lines
    }
    // A command's verdict sits at the end of its output: collapsed shows the tail.
    const sample = output.length > TOOL_PREVIEW_SCAN_MAX_CHARS ? output.slice(-TOOL_PREVIEW_SCAN_MAX_CHARS) : output
    const wrapped = components.wrapText(sample, contentWidth)
    if (wrapped.length > RESULT_PREVIEW_LINES || sample.length < output.length) {
      lines.push(sample.length < output.length
        ? this.hintRow(width, undefined, undefined)
        : this.hintRow(width, wrapped.length - RESULT_PREVIEW_LINES, wrapped.length))
    }
    lines.push(...wrapped.slice(-RESULT_PREVIEW_LINES).map(paint))
    return lines
  }

  /**
   * The presenter-less body rows: the bash fallback's `$ ` command (capped at
   * {@link COMMAND_PREVIEW_LINES} collapsed), then the result preview — a
   * recognized raw shape collapses to its summary line, anything else keeps
   * {@link RESULT_PREVIEW_LINES} wrapped rows; expanded shows every row, with
   * JSON pretty-printed.
   * @param width - current viewport width in columns.
   * @param result - the paired result, or undefined while pending.
   * @returns the body rows (possibly empty).
   */
  private renderBody(width: number, result: TranscriptToolResult | undefined): string[] {
    const { colors, components } = this
    const lines: string[] = []
    const command = this.commandPreview()
    if (command !== undefined) {
      const cap = this.expanded
        ? command.length
        : Math.min(command.length, COMMAND_PREVIEW_LINES)
      for (let index = 0; index < cap; index += 1) {
        const body = colors.muted(command[index]!)
        // Budgeted like every other composed row: a long one-liner command
        // must truncate to the viewport, not reach pi-tui's width guard.
        lines.push(index === 0
          ? components.truncateToWidth(`${PREVIEW_INDENT}${colors.shellMode('$ ')}${body}`, width)
          : components.truncateToWidth(`${PREVIEW_INDENT}  ${body}`, width))
      }
    }
    if (result === undefined) return lines
    // Leading blank lines would spend the preview on nothing.
    const raw = sanitizePluginText(result.fullText ?? result.text).replace(/\n+$/, '').replace(/^(?:[ \t]*\n)+/, '')
    if (raw === '') return lines
    const text = this.expanded ? prettyJson(raw) : raw
    const contentWidth = Math.max(1, width - components.visibleWidth(PREVIEW_INDENT))
    const paint = (line: string): string => `${PREVIEW_INDENT}${
      isPlanDecline(this.item) ? colors.warning(line)
        : result.isError ? colors.error(line)
          : colors.muted(line)
    }`
    // A recognized raw shape (XML envelope, incremental job read, or bare
    // JSON payload) collapses to its one summary line while collapsed; the
    // expanded card keeps the raw text as the debug view.
    const summarySource = text.length > TOOL_PREVIEW_SCAN_MAX_CHARS ? text.slice(0, TOOL_PREVIEW_SCAN_MAX_CHARS) : text
    const summary = summarizeToolText(summarySource)
    const preview = this.expanded
      ? boundedPreview(text, contentWidth, TOOL_EXPANDED_RENDER_LINES, components)
      : summarySource !== text
        ? boundedPreview(text, contentWidth, RESULT_PREVIEW_LINES, components)
        : summary !== text
          ? (() => {
              const lines = components.wrapText(summary, contentWidth)
              const allLines = components.wrapText(text, contentWidth)
              return {
                lines,
                more: lines.length < allLines.length,
                ...(lines.length < allLines.length ? { remaining: allLines.length - lines.length, total: allLines.length } : {}),
              }
            })()
          : boundedPreview(text, contentWidth, RESULT_PREVIEW_LINES, components)
    lines.push(...preview.lines.map(paint))
    if (preview.more) lines.push(this.hintRow(width, preview.remaining, preview.total))
    return lines
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows.
   */
  render(width: number): string[] {
    const { result } = this.item
    const body = result === undefined ? '' : sanitizePluginText(result.fullText ?? result.text)
    const key = `${width}:${this.expanded}:${this.keyed}:${this.closed}:${result ? `${result.isError}:${body}` : 'pending'}`
    if (this.cache?.key === key) return this.cache.lines
    let rows: string[]
    if (this.item.terminal !== undefined) {
      rows = this.renderTerminal(width, result)
    } else {
      const presentedWidth = Math.max(1, width - this.components.visibleWidth(PREVIEW_INDENT))
      const presented = this.presentedBody?.render(presentedWidth)
        .map(row => this.components.truncateToWidth(`${PREVIEW_INDENT}${row}`, width))
      rows = presented !== undefined && presented.length > 0 ? presented : this.renderBody(width, result)
    }
    // The indent can out-wide a degenerate viewport; every row passes the width backstop.
    const lines = ['', this.renderHeader(width), ...rows].map(row => this.components.truncateToWidth(row, width))
    this.cache = { key, lines }
    return lines
  }
}

/**
 * One failed-turn row: the `✗` marker in `error` beside the structured
 * failure's message, wrapped to the content width — the dead-endpoint
 * answer to the silent transcript (S23 dogfood).
 */
export class ErrorMessageComponent implements MayflyComponent {
  /**
   * @param item - the failed-turn item to render.
   * @param colors - the theme's color table.
   * @param components - the component factory (width wrapping).
   */
  constructor(
    private readonly item: import('./types.ts').TranscriptErrorItem,
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
  ) {}

  /** No cached render state. */
  invalidate(): void {}

  /**
   * Render the marker plus the wrapped message.
   * @param width - current render width in columns.
   * @returns one string per rendered row.
   */
  render(width: number): string[] {
    const message = sanitizePluginText(this.item.message)
    const code = this.item.code === undefined ? undefined : sanitizePluginText(this.item.code)
    const label = code !== undefined
      ? `✗ request failed (${code}): ${message}`
      : `✗ request failed: ${message}`
    return this.components.wrapText(label, width).map((line: string) => this.colors.error(line))
  }
}

/**
 * One cut-turn row: the text-presentation `■` marker and the `interrupted` label in error
 * red — the visible tombstone of an Esc interrupt (or a crash-recovery
 * close), so the stream going quiet always carries its reason (the S24a
 * dogfood ruling; round 4 moved it from textMuted to the error paint for
 * prominence).
 */
export class InterruptedMarkerComponent implements MayflyComponent {
  /**
   * @param colors - the theme's color table.
   * @param components - the component factory providing `truncateToWidth`
   *   (the fixed label still has to honor degenerate widths).
   */
  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** No cached render state. */
  invalidate(): void {}

  /**
   * Render the single error-red marker row, truncated to the width.
   * @param width - current render width in columns (the label never wraps).
   * @returns one string.
   */
  render(width: number): string[] {
    return [this.components.truncateToWidth(this.colors.error(this.t('■ interrupted')), width)]
  }
}
