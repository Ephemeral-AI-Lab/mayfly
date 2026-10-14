/**
 * The search line: two rows above the editor, the pattern being typed after its `/` or `?`, and a muted line under it that
 * the owner words (how many matches, which keys). While the line is `editable` it holds keyboard focus: text edits the
 * pattern, `Enter` accepts it, `Esc` (or `Backspace` on an empty pattern) abandons it. Once accepted the line only shows
 * the pattern and the count while the conversation holds the keys. The owner decides what a pattern matches; the line only
 * reports the pattern, the accept, and the abandon.
 * @module
 */
import { Input, matchesKey, type KeyId } from '@earendil-works/pi-tui'
import { ACTION_CANCEL } from './key-actions.ts'
import type { MayflyFocusable, MayflyKeymap, MayflySemanticColors } from './types.ts'
import { truncateToWidth } from './width.ts'

/** What the owner of a search line hears. */
export interface MayflySearchLineOptions {
  /** `/` searches toward the newer rows, `?` toward the older: the character the line starts with. */
  readonly prefix: '/' | '?'
  /** The pattern changed (typed, deleted, or pasted). */
  readonly onChange: (pattern: string) => void
  /** `Enter`: the reader accepts the pattern. */
  readonly onAccept: () => void
  /** `Esc`, or `Backspace` on an empty pattern: the reader abandons the search. */
  readonly onAbandon: () => void
}

/** A lease on the one search line of the screen. */
export interface MayflySearchLine {
  readonly disposed: boolean
  /** The muted line under the pattern: the count of matches and the keys. */
  set(status: string): void
  /** Take keyboard focus and let the pattern be edited. */
  edit(): void
  /** Stop editing: the line keeps showing the pattern, without a cursor, and no longer reads keys. */
  freeze(): void
  /** Close the line. Keyboard focus goes back to the prompt when the line held it. */
  dispose(): void
}

/** What the line paints with, read when it paints: the renderer binds after the screen exists. */
export interface MayflySearchLineHost {
  readonly colors: () => MayflySemanticColors | undefined
  readonly keymap: () => MayflyKeymap | undefined
  readonly requestRender: () => void
}

const MARGIN = '  '

/** The component behind the lease. */
export class SearchLine implements MayflyFocusable {
  private readonly input = new Input()
  private status = ''
  private focusedValue = false
  private editable = true

  constructor(private readonly options: MayflySearchLineOptions, private readonly host: MayflySearchLineHost) {}

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    this.input.focused = value && this.editable
    this.host.requestRender()
  }

  get isEditable(): boolean { return this.editable }

  setEditable(editable: boolean): void {
    this.editable = editable
    this.input.focused = this.focusedValue && editable
    this.host.requestRender()
  }

  setStatus(status: string): void {
    if (status === this.status) return
    this.status = status
    this.host.requestRender()
  }

  invalidate(): void { this.input.invalidate() }

  render(width: number): string[] {
    const colors = this.host.colors()
    const muted = (text: string): string => colors === undefined ? text : colors.muted(text)
    const lead = `${this.options.prefix} `
    // The Input draws its own `> ` prompt; the line puts its prefix in the same two columns.
    // Once accepted the pattern is plain text: the input's own cursor would say it can still be typed into.
    const drawn = this.editable ? this.input.render(Math.max(3, width - MARGIN.length))[0] ?? '> ' : `> ${this.input.getValue()}`
    const body = drawn.startsWith('> ') ? drawn.slice(2) : drawn
    const first = `${MARGIN}${colors === undefined ? lead : colors.primary(lead)}${body}`
    const second = `${' '.repeat(MARGIN.length + lead.length)}${muted(this.status)}`
    return [truncateToWidth(first, width), truncateToWidth(second, width)]
  }

  handleInput(data: string): void {
    if (!this.editable) return
    const keymap = this.host.keymap()
    if (keymap?.matches(data, ACTION_CANCEL) === true || matchesKey(data, 'escape' as KeyId) || matchesKey(data, 'ctrl+c' as KeyId)) {
      this.options.onAbandon()
      return
    }
    if (matchesKey(data, 'enter' as KeyId)) {
      this.options.onAccept()
      return
    }
    const before = this.input.getValue()
    if (before === '' && matchesKey(data, 'backspace' as KeyId)) {
      this.options.onAbandon()
      return
    }
    this.input.handleInput(data)
    const after = this.input.getValue()
    this.host.requestRender()
    if (after !== before) this.options.onChange(after)
  }
}
