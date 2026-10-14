/**
 * A fake terminal whose bytes feed a headless xterm, so a test reads the screen the alternate-screen renderer painted.
 * @module @ephemeral-ai/mayfly/core/tests/alt-screen-terminal
 */
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { FakeTerminal } from './fake-terminal.ts'

export class AltScreenTerminal extends FakeTerminal {
  private readonly vt: HeadlessTerminal

  constructor(columns = 40, rows = 10) {
    super(columns, rows)
    this.vt = new HeadlessTerminal({ cols: columns, rows, scrollback: 1000, allowProposedApi: true })
  }

  override write(data: string): void {
    super.write(data)
    this.vt.write(data)
  }

  override resize(columns: number, rows: number): void {
    this.vt.resize(columns, rows)
    super.resize(columns, rows)
  }

  externalWrite(data: string): void {
    this.vt.write(data)
  }

  async screen(): Promise<string[]> {
    await new Promise<void>(resolve => this.vt.write('', resolve))
    const buffer = this.vt.buffer.active
    return Array.from({ length: this.vt.rows }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
  }

  async bufferType(): Promise<string> {
    await new Promise<void>(resolve => this.vt.write('', resolve))
    return this.vt.buffer.active.type
  }

  dispose(): void {
    this.vt.dispose()
  }
}
