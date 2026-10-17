/**
 * Alternate-buffer VT harness: a recording `FakeTerminal` whose bytes also
 * feed a headless xterm, so a test reads the screen grid an alternate-screen
 * renderer (or the output optimizer) actually produces. Unlike
 * `tests/vt-terminal.ts` it deliberately allows the alternate buffer and
 * exposes cells and the cursor as well as row text.
 *
 * @module @ephemeral-ai/mayfly/core/tests/vt-alt-terminal
 */

import { Terminal, type IBufferCell } from '@xterm/headless'
import { FakeTerminal } from './fake-terminal.ts'

/** One active-buffer cell: character, width, colors, and attribute flags. */
export interface VtCell {
  readonly char: string
  readonly width: number
  readonly fgMode: number
  readonly fg: number
  readonly bgMode: number
  readonly bg: number
  /** Bold=1, dim=2, italic=4, underline=8, blink=16, inverse=32, invisible=64, strikethrough=128, overline=256. */
  readonly attrs: number
}

/** One flushed screen: the active buffer's viewport, all cells, and the cursor. */
export interface VtSnapshot {
  readonly type: string
  readonly rows: readonly string[]
  readonly cells: readonly (readonly VtCell[])[]
  readonly cursor: { readonly x: number, readonly y: number }
}

/** Build one cell snapshot, defaulting a missing cell to a blank default cell. */
function snapshotCell(cell: IBufferCell | undefined): VtCell {
  if (cell === undefined) return { char: '', width: 0, fgMode: 0, fg: 0, bgMode: 0, bg: 0, attrs: 0 }
  let attrs = 0
  if (cell.isBold() !== 0) attrs |= 1
  if (cell.isDim() !== 0) attrs |= 2
  if (cell.isItalic() !== 0) attrs |= 4
  if (cell.isUnderline() !== 0) attrs |= 8
  if (cell.isBlink() !== 0) attrs |= 16
  if (cell.isInverse() !== 0) attrs |= 32
  if (cell.isInvisible() !== 0) attrs |= 64
  if (cell.isStrikethrough() !== 0) attrs |= 128
  if (cell.isOverline() !== 0) attrs |= 256
  return {
    char: cell.getChars(),
    width: cell.getWidth(),
    fgMode: cell.getFgColorMode(),
    fg: cell.getFgColor(),
    bgMode: cell.getBgColorMode(),
    bg: cell.getBgColor(),
    attrs,
  }
}

/** A `FakeTerminal` that mirrors every write into an alternate-capable headless xterm. */
export class VtAltTerminal extends FakeTerminal {
  private readonly vt: Terminal

  constructor(columns = 80, rows = 24) {
    super(columns, rows)
    // No scrollback: the alternate buffer has none, and the optimizer never
    // writes below the viewport.
    this.vt = new Terminal({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  }

  override write(data: string): void {
    super.write(data)
    this.vt.write(data)
  }

  override resize(columns: number, rows: number): void {
    super.resize(columns, rows)
    this.vt.resize(columns, rows)
  }

  /** Resolve once every byte written so far has been parsed. */
  flush(): Promise<void> {
    return new Promise<void>(resolve => { this.vt.write('', resolve) })
  }

  /** The active buffer's kind (`normal` or `alternate`). */
  async bufferType(): Promise<string> {
    await this.flush()
    return this.vt.buffer.active.type
  }

  /** The active viewport's rows, trimmed right. */
  async activeRows(): Promise<string[]> {
    await this.flush()
    const buffer = this.vt.buffer.active
    return Array.from({ length: this.vt.rows }, (_, row) => {
      return buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
    })
  }

  /** The active viewport's cells, one row per line. */
  async activeCells(): Promise<VtCell[][]> {
    await this.flush()
    const buffer = this.vt.buffer.active
    return Array.from({ length: this.vt.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row)
      return Array.from({ length: this.vt.cols }, (_, column) => snapshotCell(line?.getCell(column)))
    })
  }

  /** The active buffer's cursor cell, 0-based. */
  async activeCursor(): Promise<{ readonly x: number, readonly y: number }> {
    await this.flush()
    const buffer = this.vt.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }

  /** The active buffer's rows, cells, and cursor in one flushed snapshot. */
  async snapshot(): Promise<VtSnapshot> {
    await this.flush()
    const buffer = this.vt.buffer.active
    return {
      type: buffer.type,
      rows: Array.from({ length: this.vt.rows }, (_, row) => {
        return buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
      }),
      cells: Array.from({ length: this.vt.rows }, (_, row) => {
        const line = buffer.getLine(buffer.baseY + row)
        return Array.from({ length: this.vt.cols }, (_, column) => snapshotCell(line?.getCell(column)))
      }),
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
    }
  }

  dispose(): void {
    this.vt.dispose()
  }
}
