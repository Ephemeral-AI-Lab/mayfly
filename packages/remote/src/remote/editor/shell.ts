/**
 * Remote-local `!` shell execution, output safety, and transcript-style echo.
 * @module @ephemeral-ai/mayfly/remote/editor/shell
 */

import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  MayflyComponent,
  MayflyComponents,
  MayflyScreen,
  MayflyScreenSlot,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'

const MAX_LINES = 200
const MAX_BYTES = 64 * 1024
// oxlint-disable-next-line no-control-regex -- terminal control sequences are the input being removed
const CSI = /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g
// oxlint-disable-next-line no-control-regex -- terminal control sequences are the input being removed
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
// oxlint-disable-next-line no-control-regex -- terminal control sequences are the input being removed
const ESC = /\x1b(?:[ -/][0-~]|[0-~])/g
// oxlint-disable-next-line no-control-regex -- C0 controls other than newline and tab are unsafe output
const C0 = /[\x00-\x08\x0B-\x1B\x1C-\x1F]/g

/** Strip terminal commands while retaining newlines and tabs from captured output. */
export function sanitizeShellOutput(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(C0, '')
}

export interface ShellExecution {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function cap(output: string): { readonly text: string, readonly truncated: boolean } {
  let text = output.replace(/\r?\n$/u, '')
  let truncated = false
  if (Buffer.byteLength(text) > MAX_BYTES) {
    text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8')
    truncated = true
  }
  const lines = text.split('\n')
  if (lines.length > MAX_LINES) {
    text = lines.slice(0, MAX_LINES).join('\n')
    truncated = true
  }
  return { text, truncated }
}

class ShellEcho implements MayflyComponent {
  constructor(
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly command: string,
    private readonly cwd: string,
    private readonly result: ShellExecution,
    private readonly truncated: boolean,
    private readonly t: MayflyTranslate,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const rows = [
      this.components.truncateToWidth(`${this.colors.shellMode('$ ')}${this.command}`, width),
      this.colors.textMuted(this.components.truncateToWidth(`Local cwd: ${this.cwd}`, width)),
    ]
    const stdout = sanitizeShellOutput(this.result.stdout)
    const stderr = sanitizeShellOutput(this.result.stderr)
    if (stdout !== '') rows.push(...stdout.split('\n').map(line => this.colors.textMuted(this.components.truncateToWidth(line, width))))
    if (stderr !== '') {
      const paint = this.result.code === 0 ? this.colors.textMuted : this.colors.error
      rows.push(...stderr.split('\n').map(line => paint(this.components.truncateToWidth(line, width))))
    }
    if (stdout === '' && stderr === '') rows.push(this.colors.textMuted(this.t('(no output)')))
    if (this.truncated) rows.push(this.colors.muted(this.t('… output truncated')))
    if (this.result.code !== 0) rows.push(this.colors.error(this.t('exit code {code}', { code: this.result.code })))
    return rows
  }
}

/** Execute shell commands only on the Remote machine; no Host remote.terminal call is made. */
export class EditorShell {
  private readonly children = new Set<ReturnType<typeof exec>>()
  private readonly echoes = new Set<MayflyScreenSlot>()
  private disposed = false

  constructor(
    private readonly screen: MayflyScreen,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly t: MayflyTranslate,
  ) {}

  run(command: string, cwd: string): void {
    if (this.disposed) return
    const child = exec(command, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * MAX_BYTES,
      windowsHide: true,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      this.children.delete(child)
      if (this.disposed) return
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      const out = cap(stdout)
      const err = cap(stderr)
      const echo = new ShellEcho(this.components, this.colors, command, cwd, {
        code,
        stdout: out.text,
        stderr: err.text,
      }, out.truncated || err.truncated, this.t)
      const slot = this.screen.mountContentSlot(`remote.local.shell.${randomUUID()}`, echo)
      this.echoes.add(slot)
      this.screen.requestRender()
    })
    this.children.add(child)
  }

  dispose(): void {
    this.disposed = true
    for (const child of this.children) child.kill('SIGKILL')
    this.children.clear()
    for (const slot of this.echoes) slot.dispose()
    this.echoes.clear()
  }
}
