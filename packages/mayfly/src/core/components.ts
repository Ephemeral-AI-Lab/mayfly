/**
 * `ctx.mayflyComponents` service: the L1 component factory. Maps the active
 * semantic color table to pi-tui's per-component themes inside L0, so the
 * color-table → renderer-theme mapping lives in exactly one place and no
 * pi-tui type crosses the package boundary. Width helpers are re-exported
 * under Mayfly signatures, passing straight through to pi-tui.
 *
 * @module @ephemeral-ai/mayfly/core/components
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  CURSOR_MARKER,
  CombinedAutocompleteProvider,
  Editor,
  Image,
  Markdown,
  SelectList,
  fuzzyFilter,
  fuzzyMatch,
  getCapabilities,
  getImageDimensions,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorOptions,
  type EditorTheme,
  type ImageOptions,
  type ImageTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type TUI,
} from '@earendil-works/pi-tui'
import { expandMarkdownRules, markdownTheme } from './markdown-rows.ts'
import { readPresentation, type MayflyPresentation } from './presentation.ts'
import { renderMermaidRows, splitRichDocument } from './rich-document.ts'
import { extractMentionToken, mentionPath } from '../internal/mention.ts'
import { displayPath } from '../internal/paths.ts'
import {
  highlightLeadingSlashToken,
  injectGhostHint,
  splitEditorRows,
  topRule as renderTopRule,
} from './chrome.ts'
import { CompletionList } from './completion-list.ts'
import { expandPastes, findTokenRanges, foldSegments, paintTokenRows, type EditorTokenPaints, type EditorTokenRange, type EditorTokenText } from './editor-tokens.ts'
import type {
  MayflyAutocompleteProvider,
  MayflyComponents,
  MayflyCompletionView,
  MayflyEditor,
  MayflyEditorOptions,
  MayflyEditorSubmitAttempt,
  MayflyEditorToken,
  MayflyEditorTokenSource,
  MayflySubmittedDraft,
  MayflyFuzzyMatch,
  MayflyImage,
  MayflyImageOptions,
  MayflyMarkdown,
  MayflyMarkdownOptions,
  MayflySelectItem,
  MayflySelectList,
  MayflySelectListOptions,
  MayflySemanticColors,
  MayflyTheme,
  MayflyTopRuleOptions,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyComponents: MayflyComponentsService
  }
}

/**
 * Map the palette to an editor theme: the rule color pi-tui draws its own top and bottom rules in (the adapter drops
 * them; the frame belongs to the prompt's surface) plus the autocomplete dropdown.
 */
function editorTheme(colors: MayflySemanticColors): EditorTheme {
  return { borderColor: colors.border, selectList: selectListTheme(colors) }
}

/** Map the palette to a select-list theme. */
function selectListTheme(colors: MayflySemanticColors): SelectListTheme {
  return {
    selectedPrefix: colors.primary,
    selectedText: colors.primary,
    description: colors.textMuted,
    scrollInfo: colors.textMuted,
    noMatch: colors.textMuted,
  }
}

/** Map the palette to an image theme: only the text-fallback color is used. */
function imageTheme(colors: MayflySemanticColors): ImageTheme {
  return { fallbackColor: colors.muted }
}

/**
 * The autocomplete-list factory pi-tui's `Editor` calls when new suggestions
 * arrive. pi-tui keeps it private; `createEditor` shadows it with an own
 * property (the kimi CustomEditor idiom — an own property beats the
 * prototype method), and the components spec pins the shadow against 0.84.2.
 */
interface AutocompleteListFactory {
  createAutocompleteList: (prefix: string, items: MayflySelectItem[]) => SelectList
}

/** Theme-derived paints the editor overlays on its first row (S14 completion polish). */
interface EditorChromePaints {
  /** Styling for the leading `/command` token (bold + `primary`). */
  readonly slashTokenPaint: (text: string) => string
  /** Styling for the argument-hint ghost (`textMuted`). */
  readonly ghostHintPaint: (text: string) => string
  /** The tones of the inline tokens: the label in `accent`, the brackets and size muted. */
  readonly tokenPaints: EditorTokenPaints
}

function withoutFakeEditorCursor(row: string): string {
  // pi-tui paints exactly one grapheme (or trailing space) in inverse video
  // even while unfocused; form navigation needs the text without that caret.
  return row.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/u, '$1')
}

/** The token the first Backspace selected: where it sits and what it spells. */
interface SelectedToken {
  readonly line: number
  readonly start: number
  readonly end: number
  readonly text: string
  readonly kind: EditorTokenRange['kind']
}

/** Delegate exposing a pi-tui `Editor` through the Mayfly contract. */
class EditorAdapter implements MayflyEditor {
  /**
   * Pre-dispatch hook checked by {@link EditorAdapter.handleInput} before
   * the pi-tui editor sees the input; owned by the adapter because pi-tui's
   * Editor has no equivalent interception point.
   */
  onKey: ((data: string) => boolean) | undefined

  /** Host-owned submission barrier installed above the L0 clear path. */
  private submitAttemptHandler: ((attempt: MayflyEditorSubmitAttempt) => void) | undefined

  /** Latest outstanding submission, if its owner has not settled it. */
  private activeSubmit: { readonly revision: number, cancel(): void } | undefined

  /** Monotonic submission revision; a newer attempt invalidates the previous. */
  private submitRevision = 0

  /** Changes whenever the host replaces the barrier callback. */
  private submitBarrierRevision = 0

  /** Changes whenever the expanded editor buffer changes. */
  private mutationRevision = 0

  /** Last raw and paste-expanded values observed through the adapter boundary. */
  private observedBuffer: { readonly raw: string, readonly expanded: string }

  /** Original pi-tui submit implementation, captured before the shadow. */
  private readonly nativeSubmit: () => void

  /** Buffer and paste table captured by the in-flight native submission. */
  private submittedDraft: MayflySubmittedDraft | undefined

  /** Whether the buffer is a shell command: a leading `/` is then a path, not a command, and stays unpainted. */
  private shellMode = false

  /** The argument-hint ghost (S14); none while unset. */
  private ghostHint: string | undefined

  /** The interaction-owned inline tokens (image markers, accepted mentions); none while unset. */
  private tokenSource: MayflyEditorTokenSource | undefined

  /** The token the first Backspace selected; valid only while its text still sits at that place. */
  private selectedToken: SelectedToken | undefined

  /** Whether `tokenBackspace` ran during the current input, so the input does not clear its selection. */
  private tokenHandled = false

  /** The latest snapshot of the buffer and its paste table (a submit, a steer, a clear): the text a history entry came from. */
  private lastCaptured: MayflySubmittedDraft | undefined

  /** The paste tables of the history entries, index for index with pi-tui's own list (newest first). */
  private historyPastes: Array<ReadonlyMap<number, string> | undefined> = []

  /** The paste table of the draft that history browsing left, which `Down` back to the draft re-arms. */
  private draftPastes: ReadonlyMap<number, string> = new Map()

  /** What `onTokenChange` last told the host, to speak only on a change. */
  private announcedToken: string | undefined

  onTokenChange: ((token: MayflyEditorToken | undefined) => void) | undefined

  constructor(
    private readonly editor: Editor,
    private readonly chrome: EditorChromePaints,
    /** The list pi-tui's factory last made; it is the open list while the editor shows one. */
    private readonly completions: { list: CompletionList | undefined },
  ) {
    this.observedBuffer = { raw: editor.getText(), expanded: editor.getExpandedText() }
    const bridge = editor as unknown as { submitValue(): void }
    const submitValue = bridge.submitValue.bind(editor)
    this.nativeSubmit = () => {
      // Snapshot before pi-tui's submitValue clears the buffer, paste table,
      // undo stack, and history cursor: the withdrawn-message restore needs
      // the raw marker text and the table its `[paste #N]` markers expand
      // through.
      this.submittedDraft = this.captureDraft()
      submitValue()
    }
    bridge.submitValue = () => { this.requestSubmit() }
  }

  captureDraft(): MayflySubmittedDraft {
    // pi-tui's `pastes` is a private field (0.84.2) though it is a plain
    // instance field; the structural cast is pinned by the components spec,
    // the `getHistory` precedent.
    const internals = this.editor as unknown as { pastes: Map<number, string> }
    const captured = { raw: this.editor.getText(), pastes: new Map(internals.pastes) }
    // The latest buffer that held a pasted block stays the source of its history entry, which is added after the buffer
    // was cleared (and the clear's own capture is empty).
    if (captured.pastes.size > 0) this.lastCaptured = captured
    return captured
  }

  consumeSubmittedDraft(): MayflySubmittedDraft | undefined {
    const draft = this.submittedDraft
    this.submittedDraft = undefined
    return draft
  }

  restoreSubmittedDraft(draft: MayflySubmittedDraft): void {
    this.setText(draft.raw)
    // `setText` cleared the paste table; repopulate it (and never rewind
    // `pasteCounter` below the marker ids) so the restored `[paste #N]`
    // markers expand again — the same private-field cast as `captureDraft`.
    this.armPastes(draft.pastes)
    this.observeMutation()
  }

  /** Make `table` the paste table, never rewinding `pasteCounter` below its ids (the private fields the draft capture reads). */
  private armPastes(table: ReadonlyMap<number, string>): void {
    const internals = this.editor as unknown as { pastes: Map<number, string>, pasteCounter: number }
    internals.pastes = new Map(table)
    internals.pasteCounter = Math.max(0, ...table.keys())
  }

  setTextFolding(text: string, contents: readonly string[]): void {
    this.setText('')
    for (const segment of foldSegments(text, contents)) {
      // A paste goes in as the terminal sends one, so the editor folds it into a marker again when it is big enough.
      if (segment.paste) this.editor.handleInput(`\x1b[200~${segment.text}\x1b[201~`)
      else this.editor.insertTextAtCursor(segment.text)
    }
    this.observeMutation()
    this.announceToken()
  }

  get focused(): boolean {
    return this.editor.focused
  }

  set focused(value: boolean) {
    this.editor.focused = value
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.editor.onSubmit
  }

  set onSubmit(callback: ((text: string) => void) | undefined) {
    if (callback === undefined) delete this.editor.onSubmit
    else this.editor.onSubmit = callback
  }

  setSubmitBarrier(callback: ((attempt: MayflyEditorSubmitAttempt) => void) | undefined): void {
    this.submitBarrierRevision += 1
    this.submitAttemptHandler = callback
    this.activeSubmit?.cancel()
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.editor.onChange
  }

  set onChange(callback: ((text: string) => void) | undefined) {
    if (callback === undefined) delete this.editor.onChange
    else this.editor.onChange = callback
  }

  get disableSubmit(): boolean {
    return this.editor.disableSubmit
  }

  set disableSubmit(value: boolean) {
    this.editor.disableSubmit = value
  }

  getText(): string {
    return this.editor.getText()
  }

  setText(text: string): void {
    this.selectedToken = undefined
    this.editor.setText(text)
    this.observeMutation()
    this.announceToken()
  }

  submit(): void {
    if (this.disableSubmit) return
    this.requestSubmit()
  }

  addToHistory(text: string, pastes?: ReadonlyMap<number, string>): void {
    // A message that held a pasted block is kept as it was typed (the marker and its table), not as the expanded text:
    // recalling it brings the token back. The text may be the expansion of the latest capture, or its raw buffer.
    const trimmed = text.trim()
    const capture = [this.lastCaptured, this.snapshot()].find(candidate => candidate !== undefined && candidate.pastes.size > 0
      && (candidate.raw.trim() === trimmed || expandPastes(candidate.raw, candidate.pastes).trim() === trimmed))
    const entry = pastes === undefined ? (capture === undefined ? trimmed : capture.raw.trim()) : trimmed
    const table = pastes ?? capture?.pastes
    const internals = this.editor as unknown as { history: string[] }
    const length = internals.history.length
    const head = internals.history[0]
    this.editor.addToHistory(entry)
    if (internals.history.length !== length || internals.history[0] !== head) this.historyPastes.unshift(table)
    else if (entry !== '' && entry === head) this.historyPastes[0] = table
    this.historyPastes.length = internals.history.length
  }

  /** The buffer and paste table as they stand, without making them the latest capture. */
  private snapshot(): MayflySubmittedDraft {
    return { raw: this.editor.getText(), pastes: new Map((this.editor as unknown as { pastes: Map<number, string> }).pastes) }
  }

  getHistoryPastes(): readonly (ReadonlyMap<number, string> | undefined)[] {
    return [...this.historyPastes]
  }

  getHistory(): readonly string[] {
    // pi-tui types `history` private (0.84.2) though it is a plain instance
    // field; the single structural cast (via `unknown` — the private field
    // blocks a direct overlap) is pinned by the components spec.
    const history = (this.editor as unknown as { history: string[] }).history
    return [...history]
  }

  removeLatestHistory(text: string): boolean {
    const history = (this.editor as unknown as { history: string[] }).history
    const head = history[0]
    if (head === undefined || (head !== text && expandPastes(head, this.historyPastes[0] ?? new Map()) !== text)) return false
    history.shift()
    this.historyPastes.shift()
    return true
  }

  setShellMode(shell: boolean): void {
    this.shellMode = shell
  }

  setGhostHint(hint: string | undefined): void {
    this.ghostHint = hint
  }

  setTokenSource(source: MayflyEditorTokenSource | undefined): void {
    this.tokenSource = source
    this.selectedToken = undefined
    this.announceToken()
  }

  /** The tokens of one buffer line. */
  private rangesOf(text: string): EditorTokenRange[] {
    return findTokenRanges(text, this.pasteIds(), this.tokenSource?.(text))
  }

  /**
   * The token the caret is on: one a block cursor would cover (`start <= col < end`), else the one that ends at the caret.
   * @returns the token with its place, or `undefined` when the caret is on none.
   */
  private tokenAtCaret(): SelectedToken | undefined {
    const { line, col } = this.editor.getCursor()
    const text = this.editor.getLines()[line] ?? ''
    const ranges = this.rangesOf(text)
    const range = ranges.find(candidate => col >= candidate.start && col < candidate.end) ?? ranges.find(candidate => col > candidate.start && col === candidate.end)
    return range === undefined ? undefined : { line, start: range.start, end: range.end, text: text.slice(range.start, range.end), kind: range.kind }
  }

  /** Whether the caret's block cursor covers the token (as opposed to resting right after it). */
  private covers(token: SelectedToken): boolean {
    const { line, col } = this.editor.getCursor()
    return token.line === line && col >= token.start && col < token.end
  }

  /** The selection, if it still names the text under the caret. */
  private validSelection(): SelectedToken | undefined {
    const selected = this.selectedToken
    const here = this.tokenAtCaret()
    if (selected === undefined || here === undefined) return undefined
    return selected.line === here.line && selected.start === here.start && selected.end === here.end && selected.text === here.text ? selected : undefined
  }

  tokenBackspace(): boolean {
    this.tokenHandled = true
    const here = this.tokenAtCaret()
    if (here === undefined) {
      this.selectedToken = undefined
      return false
    }
    // A token the caret is on is already highlighted: Backspace removes it. Right after it, the first press selects it.
    if (this.validSelection() !== undefined || this.covers(here)) {
      this.removeToken(here)
      return true
    }
    this.selectedToken = here
    // A list that reopened behind the mention would cover the hint that says what the next key does.
    this.closeCompletion()
    this.announceToken()
    return true
  }

  activeToken(): MayflyEditorToken | undefined {
    const selected = this.validSelection()
    const token = selected ?? this.tokenAtCaret()
    // The caret resting right after a token is not on it until Backspace selects it.
    if (token === undefined || (selected === undefined && !this.covers(token))) return undefined
    const id = token.kind === 'paste' ? Number(/#(\d+)/u.exec(token.text)?.[1]) : undefined
    const content = id === undefined ? undefined : (this.editor as unknown as { pastes: Map<number, string> }).pastes.get(id)
    return { kind: token.kind, text: token.text, selected: selected !== undefined, ...content === undefined ? {} : { content } }
  }

  replaceActiveToken(text: string): void {
    const token = this.validSelection() ?? this.tokenAtCaret()
    if (token === undefined) return
    this.removeToken(token)
    // As a paste, so a block that is still big folds into a token again.
    if (token.kind === 'paste') this.editor.handleInput(`\x1b[200~${text}\x1b[201~`)
    else this.editor.insertTextAtCursor(text)
    this.observeMutation()
    this.announceToken()
  }

  /** Tell the host when the active token changes. */
  private announceToken(): void {
    const token = this.focused ? this.activeToken() : undefined
    const key = token === undefined ? undefined : `${token.kind}|${token.text}|${String(token.selected)}`
    if (key === this.announcedToken) return
    this.announcedToken = key
    this.onTokenChange?.(token)
  }

  /**
   * Left and Right step over a token as one unit: Left from the end lands on its start (the block cursor covers it),
   * Right from its start lands on its end. A caret elsewhere moves as the editor moves it.
   * @returns whether the key was the step over a token.
   */
  private stepOverToken(data: string): boolean {
    const right = matchesKey(data, 'right')
    if (!right && !matchesKey(data, 'left')) return false
    const { line, col } = this.editor.getCursor()
    const ranges = this.rangesOf(this.editor.getLines()[line] ?? '')
    if (right) {
      const range = ranges.find(candidate => col >= candidate.start && col < candidate.end)
      if (range === undefined) return false
      for (let guard = range.end - range.start; guard > 0 && this.editor.getCursor().col < range.end; guard -= 1) this.editor.handleInput('\x1b[C')
      return true
    }
    const range = ranges.find(candidate => col > candidate.start && col <= candidate.end)
    if (range === undefined) return false
    for (let guard = range.end - range.start; guard > 0 && this.editor.getCursor().col > range.start; guard -= 1) this.editor.handleInput('\x1b[D')
    return true
  }

  /** The ids of the editor's paste table, which decide which `[paste #N]` markers are tokens. */
  private pasteIds(): ReadonlySet<number> {
    return new Set((this.editor as unknown as { pastes: Map<number, string> }).pastes.keys())
  }

  /**
   * Remove a token through the editor's own keys, so undo, change events, and a pasted block's renumbering are pi-tui's:
   * the caret moves to the token's end, then one Backspace removes a pasted block (it is one unit) and one per
   * character removes the rest.
   */
  private removeToken(token: SelectedToken): void {
    this.selectedToken = undefined
    for (let guard = token.end - token.start; guard > 0 && this.editor.getCursor().col < token.end; guard -= 1) this.editor.handleInput('\x1b[C')
    if (token.kind === 'paste') this.editor.handleInput('\x7f')
    else for (let left = token.end - token.start; left > 0 && this.editor.getCursor().col > token.start; left -= 1) this.editor.handleInput('\x7f')
    this.closeCompletion()
    this.observeMutation()
    this.announceToken()
  }

  /** Close the completion list; `cancelAutocomplete` is private in 0.84.2, the structural cast the components spec pins. */
  private closeCompletion(): void {
    if (!this.editor.isShowingAutocomplete()) return
    const cancel = this.editor as unknown as { cancelAutocomplete(): void }
    cancel.cancelAutocomplete()
  }

  /** The rendered rows with every token of the buffer in its tone, the selected one inverse. */
  private paintTokens(rows: string[]): string[] {
    const ids = this.pasteIds()
    // The selected token, else the one the caret covers (only while the editor has the keys).
    const selected = this.validSelection() ?? (this.focused ? this.tokenAtCaret() : undefined)
    const showing = selected !== undefined && (this.selectedToken !== undefined || this.covers(selected)) ? selected : undefined
    const tokens: EditorTokenText[] = []
    let chosen: number | undefined
    this.editor.getLines().forEach((line, index) => {
      for (const range of findTokenRanges(line, ids, this.tokenSource?.(line))) {
        if (showing !== undefined && showing.line === index && showing.start === range.start && showing.end === range.end) chosen = tokens.length
        tokens.push({ text: line.slice(range.start, range.end), kind: range.kind })
      }
    })
    return tokens.length === 0 ? rows : paintTokenRows(rows, tokens, chosen, this.chrome.tokenPaints, CURSOR_MARKER)
  }

  /**
   * Whether the cursor sits at the end of the input's first line — the only
   * position the argument-hint ghost belongs (the kimi `computeArgumentHint`
   * cursor gate). History recall parks the cursor at the recalled text's
   * start, and a mid-text cursor means the user is editing, not about to
   * supply arguments; in both the ghost declines.
   * @returns whether the ghost may render.
   */
  private cursorAtInputEnd(): boolean {
    const { line, col } = this.editor.getCursor()
    if (line !== 0) return false
    // The buffer always carries at least one line (pi-tui normalizes even
    // an empty setText to ['']); the fallback only satisfies the
    // index-access checker.
    /* defensive default, unreachable with a real editor */
    const first = this.editor.getLines()[0] ?? ''
    return col === first.length
  }

  setAutocompleteProvider(provider: MayflyAutocompleteProvider): void {
    // MayflyAutocompleteProvider is structurally identical to pi-tui's
    // AutocompleteProvider, so it passes through without wrapping; the pi-tui
    // type itself never crosses the Mayfly signature.
    this.editor.setAutocompleteProvider(provider)
  }

  getExpandedText(): string {
    return this.editor.getExpandedText()
  }

  renderContent(width: number, masked = false): string[] {
    const state = (this.editor as unknown as { state: { lines: string[] } }).state
    const original = state.lines
    if (masked) {
      state.lines = original.map(line => '•'.repeat(line.length))
      this.editor.invalidate()
    }
    try {
      const rows = this.editor.render(Math.max(1, width)).slice(1, -1)
      if (masked) return this.focused ? rows : rows.map(withoutFakeEditorCursor)
      return this.paintTokens(this.focused ? rows : rows.map(withoutFakeEditorCursor))
    } finally {
      state.lines = original
      if (masked) this.editor.invalidate()
    }
  }

  insertText(text: string): void {
    this.selectedToken = undefined
    this.editor.insertTextAtCursor(text)
    this.observeMutation()
    this.announceToken()
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete()
  }

  completion(): MayflyCompletionView | undefined {
    return this.editor.isShowingAutocomplete() ? this.completions.list?.view() : undefined
  }

  refreshAutocomplete(): void {
    const editor = this.editor as unknown as { updateAutocomplete(): void }
    editor.updateAutocomplete()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    // pi-tui draws its own rules around the content; the prompt's surface owns the frame, so only the content rows and
    // the completion list under them leave. The first content row carries the S14 completion polish in the kimi order:
    // the leading `/command` token paints bold+primary, then the argument-hint ghost splices in after the cursor. In
    // shell mode a leading `/` is a path separator, not a command, and stays unpainted.
    const split = splitEditorRows(this.editor.render(safeWidth))
    const list = split.list
    const content = this.paintTokens(split.content)
    /* the real editor always renders at least one content row between the rules, so content[0] exists */
    let row = content[0] ?? ''
    if (!this.shellMode && this.editor.getText().trimStart().startsWith('/')) {
      row = highlightLeadingSlashToken(row, this.chrome.slashTokenPaint) ?? row
    }
    if (this.ghostHint !== undefined && this.cursorAtInputEnd()) {
      row = injectGhostHint(row, this.ghostHint, this.editor.getText(), safeWidth, this.chrome.ghostHintPaint)
    }
    return [row, ...content.slice(1), ...list]
  }

  handleInput(data: string): void {
    // The onKey hook intercepts before delegation; true consumes the input. Any input but the token's own Backspace
    // clears a token's selection.
    this.tokenHandled = false
    if (this.onKey?.(data) === true) {
      if (!this.tokenHandled) this.selectedToken = undefined
      this.announceToken()
      return
    }
    this.selectedToken = undefined
    const browsing = this.historyBrowse()
    if (!this.stepOverToken(data)) this.editor.handleInput(data)
    this.followHistory(browsing)
    this.observeMutation()
    this.reopenAutocompleteAfterInput()
    this.announceToken()
  }

  /** Where history browsing stands before an input, with the paste table of the buffer it is about to leave. */
  private historyBrowse(): { readonly index: number, readonly pastes: ReadonlyMap<number, string> } {
    const internals = this.editor as unknown as { historyIndex: number, pastes: Map<number, string> }
    return { index: internals.historyIndex, pastes: new Map(internals.pastes) }
  }

  /**
   * History recall swaps the buffer's text but not the editor's paste table, so a recalled `[paste #N]` marker would
   * have no content. After an input that moved through history, the table of the entry now shown is armed (the
   * draft's own when it is back to the draft).
   */
  private followHistory(before: { readonly index: number, readonly pastes: ReadonlyMap<number, string> }): void {
    const internals = this.editor as unknown as { historyIndex: number }
    const index = internals.historyIndex
    if (index === before.index) return
    if (before.index === -1) this.draftPastes = before.pastes
    this.armPastes(index === -1 ? this.draftPastes : this.historyPastes[index] ?? new Map())
    // The text moved before its table did: the host's mirror of the draft reads both.
    this.editor.onChange?.(this.editor.getText())
  }

  /** Invalidate an outstanding attempt when the expanded buffer changed. */
  private observeMutation(): void {
    const current = { raw: this.editor.getText(), expanded: this.editor.getExpandedText() }
    if (current.raw === this.observedBuffer.raw && current.expanded === this.observedBuffer.expanded) return
    this.observedBuffer = current
    this.mutationRevision += 1
    this.activeSubmit?.cancel()
  }

  /** Capture one pre-clear submission and hand it to the current barrier. */
  private requestSubmit(): void {
    // Autocomplete can mutate the buffer inside the same L0 input dispatch
    // immediately before it falls through to submitValue.
    this.observeMutation()
    if (this.submitAttemptHandler === undefined) {
      this.nativeSubmit()
      this.observedBuffer = { raw: this.editor.getText(), expanded: this.editor.getExpandedText() }
      return
    }

    const revision = ++this.submitRevision
    this.activeSubmit?.cancel()
    // Abort listeners run synchronously and may submit again. That nested,
    // newer request owns the slot; this outer request must not overwrite it.
    if (this.submitRevision !== revision) return
    const handler = this.submitAttemptHandler
    if (handler === undefined) {
      this.nativeSubmit()
      this.observedBuffer = { raw: this.editor.getText(), expanded: this.editor.getExpandedText() }
      return
    }
    const barrierRevision = this.submitBarrierRevision
    const mutationRevision = this.mutationRevision
    const raw = this.editor.getText()
    const text = this.editor.getExpandedText().trim()
    const controller = new AbortController()
    let settled = false
    const cancel = (): void => {
      if (settled) return
      settled = true
      this.activeSubmit = undefined
      controller.abort()
    }
    const attempt: MayflyEditorSubmitAttempt = Object.freeze({
      text,
      signal: controller.signal,
      revision,
      commit: (): boolean => {
        if (settled
          || this.activeSubmit?.revision !== revision
          || barrierRevision !== this.submitBarrierRevision
          || mutationRevision !== this.mutationRevision
          || this.editor.getText() !== raw
          || this.editor.getExpandedText().trim() !== text) return false
        settled = true
        this.activeSubmit = undefined
        this.nativeSubmit()
        this.observedBuffer = { raw: this.editor.getText(), expanded: this.editor.getExpandedText() }
        return true
      },
      cancel,
    })
    this.activeSubmit = { revision, cancel }
    try {
      handler(attempt)
    } catch {
      cancel()
    }
  }

  /**
   * The kimi `reopenAutocompleteAfterInput` port, plus a bare-`@` backstop:
   * after any input event, re-open the completion dropdown when the mention
   * token ends in `/` (directory drill-down — accepting a directory or
   * typing the separator leaves no renderer trigger behind) or when the
   * token is exactly `@` (a freshly opened mention — the renderer's own
   * trigger fires inside `insertCharacter`, and this covers any input path
   * that reaches the buffer without it). `tryTriggerAutocomplete` is
   * private in 0.84.2; the structural cast (via `unknown`) is pinned by the
   * components spec, the `getHistory` precedent.
   */
  private reopenAutocompleteAfterInput(): void {
    if (this.editor.isShowingAutocomplete()) return
    const { line, col } = this.editor.getCursor()
    /* the real editor always renders the cursor line; the fallback only satisfies the index-access checker */
    const textBeforeCursor = (this.editor.getLines()[line] ?? '').slice(0, col)
    const token = extractMentionToken(textBeforeCursor)
    if (token === null) return
    if (token !== '@' && !displayPath(mentionPath(token)).endsWith('/')) return
    // The cast lands on a local — the repo's no-semicolon style cannot start
    // a statement with `(`.
    const trigger = this.editor as unknown as { tryTriggerAutocomplete(): void }
    trigger.tryTriggerAutocomplete()
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}

/** Delegate exposing a pi-tui `Markdown` through the Mayfly contract. */
class MarkdownAdapter implements MayflyMarkdown {
  private readonly markdown: Markdown
  private text: string
  private segments: ReturnType<typeof splitRichDocument> | undefined
  private cache: { readonly width: number, readonly rows: string[] } | undefined

  /**
   * @param markdown - the wrapped pi-tui Markdown.
   * @param hr - the exact horizontal-rule paint the wrapped markdown's
   *   theme uses (the `markdownTheme` function pins `hr: colors.mdHr`);
   *   lets the adapter re-paint pi-tui's width-capped rule.
   */
  constructor(
    text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
    private readonly theme: MarkdownTheme,
    private readonly hr: (text: string) => string,
  ) {
    this.text = text
    this.markdown = new Markdown(text, paddingX, paddingY, theme)
  }

  setText(text: string): void {
    if (text === this.text) return
    this.text = text
    this.segments = undefined
    this.cache = undefined
    this.markdown.setText(text)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
    if (this.cache?.width === safeWidth) return this.cache.rows
    const segments = this.segments ??= splitRichDocument(this.text)
    if (!segments.some(segment => segment.kind === 'mermaid')) {
      const rows = expandMarkdownRules(this.markdown.render(safeWidth), safeWidth, this.hr)
      this.cache = { width: safeWidth, rows }
      return rows
    }
    const padX = Math.min(Math.max(0, Math.floor(this.paddingX)), Math.max(0, Math.floor((safeWidth - 1) / 2)))
    const padY = Math.max(0, Math.floor(this.paddingY))
    const contentWidth = Math.max(1, safeWidth - padX * 2)
    const body = segments.flatMap(segment => {
      if (segment.kind === 'mermaid') {
        const diagram = renderMermaidRows(segment.source, contentWidth)
        if (diagram !== undefined) return diagram
        return expandMarkdownRules(new Markdown(segment.fallback, 0, 0, this.theme).render(contentWidth), contentWidth, this.hr)
      }
      /* splitRichDocument omits zero-length Markdown segments. */
      if (segment.source.length === 0) return []
      return expandMarkdownRules(new Markdown(segment.source, 0, 0, this.theme).render(contentWidth), contentWidth, this.hr)
    })
    const horizontal = padX === 0 ? body : body.map(line => `${' '.repeat(padX)}${line}`)
    const result = [...Array.from({ length: padY }, () => ''), ...horizontal, ...Array.from({ length: padY }, () => '')]
    this.cache = { width: safeWidth, rows: result }
    return result
  }

  invalidate(): void {
    this.cache = undefined
    this.markdown.invalidate()
  }
}

/** Delegate exposing a pi-tui `Image` through the Mayfly contract. */
class ImageAdapter implements MayflyImage {
  constructor(private readonly image: Image) {}

  render(width: number): string[] {
    return this.image.render(width)
  }

  invalidate(): void {
    this.image.invalidate()
  }
}

/** Delegate exposing a pi-tui `SelectList` through the Mayfly contract. */
class SelectListAdapter implements MayflySelectList {
  constructor(private readonly list: SelectList) {}

  getSelectedItem(): MayflySelectItem | null {
    return this.list.getSelectedItem()
  }

  render(width: number): string[] {
    return this.list.render(width)
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  invalidate(): void {
    this.list.invalidate()
  }
}

/** Constructor config for {@link MayflyComponentsService} (Cordis class-plugin arity). */
export interface MayflyComponentsDeps {
  /** The active semantic color provider. */
  theme: MayflyTheme
  /** The stable TUI reference the editor component binds to (pi-tui type, core-internal). */
  tui: TUI
}

/**
 * The `mayflyComponents` service. Mounted by the `mayfly-core` plugin as a
 * sub-plugin injecting `mayflyTheme`, so a theme-provider swap rebuilds this
 * service — and every component created afterwards — through Cordis reload
 * semantics. Unregistered automatically when the fiber unloads.
 */
export class MayflyComponentsService extends Service implements MayflyComponents {
  private readonly theme: MayflyTheme
  private readonly tui: TUI
  readonly presentation: MayflyPresentation

  /**
   * Create and register the service.
   * @param ctx - the owning Cordis context.
   * @param deps - the active theme and the stable TUI reference.
   */
  constructor(ctx: Context, deps: MayflyComponentsDeps) {
    super(ctx, 'mayflyComponents')
    this.theme = deps.theme
    this.tui = deps.tui
    this.presentation = readPresentation(ctx)
  }

  strong(text: string): string { return `\x1b[1m${text}\x1b[22m` }
  italic(text: string): string { return `\x1b[3m${text}\x1b[23m` }
  strike(text: string): string { return `\x1b[9m${text}\x1b[29m` }

  /**
   * Create a palette-themed multi-line input editor. Its autocomplete list
   * keeps pi-tui's state and keys but paints no rows (`CompletionList`): the
   * host draws it as a drawer over the stream, so the editor never grows.
   * @param options - editor options.
   * @returns the editor component.
   */
  createEditor(options?: MayflyEditorOptions): MayflyEditor {
    const editorOptions: EditorOptions = {}
    if (options?.paddingX !== undefined) editorOptions.paddingX = options.paddingX
    const colors = this.theme.colors
    const theme = editorTheme(colors)
    // Explicit annotation: the shadow below references `editor` in its own
    // initializer, which defeats inference otherwise.
    const editor: Editor = new Editor(this.tui, theme, editorOptions)
    // pi-tui's Editor instantiates the dropdown list through its private
    // createAutocompleteList; the own-property shadow swaps in the state-only
    // list and remembers it for the adapter. The cast lands on a local — the
    // repo's no-semicolon style cannot start a statement with `(`.
    const completions: { list: CompletionList | undefined } = { list: undefined }
    const factory = editor as unknown as AutocompleteListFactory
    factory.createAutocompleteList = (prefix: string, items: MayflySelectItem[]): SelectList => {
      completions.list = new CompletionList(items, editor.getAutocompleteMaxVisible(), theme.selectList, prefix)
      return completions.list
    }
    return new EditorAdapter(editor, {
      slashTokenPaint: (text) => `\x1b[1m${colors.primary(text)}\x1b[22m`,
      ghostHintPaint: colors.textMuted,
      tokenPaints: { label: colors.accent, detail: colors.muted },
    }, completions)
  }

  /**
   * Create a palette-themed streamed-Markdown component.
   * @param options - markdown options.
   * @returns the markdown component.
   */
  createMarkdown(options?: MayflyMarkdownOptions): MayflyMarkdown {
    return new MarkdownAdapter(
      options?.text ?? '',
      options?.paddingX ?? 0,
      options?.paddingY ?? 0,
      markdownTheme(this.theme.colors),
      this.theme.colors.mdHr,
    )
  }

  /**
   * Create a palette-themed inline image component. The bytes are base64-encoded
   * for the renderer; terminals without an image protocol render the styled
   * text fallback (muted filename, MIME type, and pixel dimensions).
   * @param options - the image bytes, MIME type, and cell bounds.
   * @returns the image component.
   */
  createImage(options: MayflyImageOptions): MayflyImage {
    const imageOptions: ImageOptions = {}
    if (options.maxWidthCells !== undefined) imageOptions.maxWidthCells = options.maxWidthCells
    if (options.maxHeightCells !== undefined) imageOptions.maxHeightCells = options.maxHeightCells
    if (options.filename !== undefined) imageOptions.filename = options.filename
    return new ImageAdapter(
      new Image(Buffer.from(options.data).toString('base64'), options.mediaType, imageTheme(this.theme.colors), imageOptions),
    )
  }

  /**
   * Whether the terminal draws images.
   * @returns true when the detected terminal has an image protocol.
   */
  imageProtocol(): boolean {
    return getCapabilities().images !== null
  }

  /**
   * Probe the pixel dimensions of encoded image data.
   * @param data - the encoded image bytes (PNG, JPEG, GIF, or WebP).
   * @returns the pixel dimensions, or `undefined` for undecodable data.
   */
  imageDimensions(data: Uint8Array): { width: number, height: number } | undefined {
    // The contract takes no MIME type, so each decoder pi-tui supports is
    // tried in turn; every decoder validates its own magic bytes and returns
    // null on a mismatch.
    const base64 = Buffer.from(data).toString('base64')
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const dimensions = getImageDimensions(base64, mediaType)
      if (dimensions !== null) return { width: dimensions.widthPx, height: dimensions.heightPx }
    }
    return undefined
  }

  /**
   * Create the `@`-mention completion source: the renderer's combined
   * provider constructed with no commands, so only its `@` branch ever runs.
   * `MayflyAutocompleteProvider` is structurally identical to the renderer's
   * provider type, so the instance passes through unwrapped — the renderer
   * type never crosses the Mayfly signature.
   * @param basePath - the project root relative paths are reported from.
   * @param fdPath - the `fd` binary to spawn, or `null` when unavailable.
   * @returns the mention completion source.
   */
  createFileMentionProvider(basePath: string, fdPath: string | null): MayflyAutocompleteProvider {
    return new CombinedAutocompleteProvider([], basePath, fdPath)
  }

  /**
   * Create a palette-themed single-selection list.
   * @param options - items and selection callbacks.
   * @returns the list component.
   */
  createSelectList(options: MayflySelectListOptions): MayflySelectList {
    const list = new SelectList(options.items, options.maxVisible ?? 10, selectListTheme(this.theme.colors))
    if (options.onSelect !== undefined) list.onSelect = options.onSelect
    if (options.onCancel !== undefined) list.onCancel = options.onCancel
    if (options.onSelectionChange !== undefined) list.onSelectionChange = options.onSelectionChange
    return new SelectListAdapter(list)
  }

  /**
   * Measure the visible width of styled text in terminal columns.
   * @param text - the text, ANSI styling allowed.
   * @returns the width in columns.
   */
  visibleWidth(text: string): number {
    return visibleWidth(text)
  }

  /**
   * Word-wrap styled text to a column width, preserving ANSI styling.
   * @param text - the text, ANSI styling and newlines allowed.
   * @param width - the maximum visible width per line.
   * @returns the wrapped lines, not padded.
   */
  wrapText(text: string, width: number): string[] {
    return wrapTextWithAnsi(text, width)
  }

  /**
   * Truncate styled text to a maximum visible width.
   * @param text - the text, ANSI styling allowed.
   * @param width - the maximum visible width.
   * @param ellipsis - the ellipsis string; defaults to `'...'`.
   * @returns the truncated text.
   */
  truncateToWidth(text: string, width: number, ellipsis?: string): string {
    return truncateToWidth(text, width, ellipsis)
  }

  /**
   * Render the bounded top rule used by connected renderer-owned panes.
   * @param width - the target visible width.
   * @param options - optional title, hint, and paint functions.
   * @returns the ANSI-safe rule row.
   */
  topRule(width: number, options?: MayflyTopRuleOptions): string {
    return renderTopRule(width, options)
  }

  /**
   * Probe a case-insensitive fuzzy subsequence match (the S14 completion
   * primitive; re-exported from the renderer so no consumer imports pi-tui).
   * @param query - the query characters, matched in order.
   * @param text - the candidate text.
   * @returns whether it matched and at what score.
   */
  fuzzyMatch(query: string, text: string): MayflyFuzzyMatch {
    return fuzzyMatch(query, text)
  }

  /**
   * Filter and rank items by a fuzzy query (see the contract doc).
   * @param items - the candidates.
   * @param query - the fuzzy query.
   * @param getText - extracts the match text from an item.
   * @returns the matching items, best first.
   */
  fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
    return fuzzyFilter([...items], query, getText)
  }
}
