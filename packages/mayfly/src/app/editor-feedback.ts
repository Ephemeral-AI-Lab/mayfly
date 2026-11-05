/** Prompt teaching facts and delayed waits owned by one Remote editor mount. @module remote/editor-feedback */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyEditor } from '../core.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { EditorToken } from './editor/types.ts'

interface PromptWait {
  readonly message: string
  readonly end: () => void
  shown: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Reads the actual editor and operation lifetimes; retains only notification presentation. */
export class RemoteEditorFeedback {
  private readonly waits: PromptWait[] = []
  private recallKey = ''
  private hint: string | undefined
  private disposed = false

  constructor(private readonly ctx: Context, private readonly t: MayflyTranslate) {
    ctx.effect(() => () => { this.dispose() })
  }

  /** Publish a changed position from the native editor's history cursor. */
  recall(editor: MayflyEditor): void {
    if (this.disposed) return
    const position = editor.getHistoryPosition?.()
    const key = position === undefined ? '' : `${String(position.index)}/${String(position.total)}`
    if (key === this.recallKey) return
    this.recallKey = key
    this.ctx.emit('mayfly/prompt-recall-changed', position)
  }

  /** Publish the reference teaching hint for the editor's actual active token. */
  token(token: EditorToken | undefined): void {
    if (this.disposed) return
    const hint = token === undefined ? undefined : this.t(token.kind === 'image'
      ? 'Ctrl+G shows it · Backspace removes'
      : 'Ctrl+G opens · Backspace removes')
    if (hint === this.hint) return
    this.hint = hint
    this.ctx.emit('mayfly/prompt-hint-changed', hint)
  }

  /** A quick result stays quiet; overlapping slow operations show the newest live wait. */
  beginWait(message: string, signal: AbortSignal): () => void {
    if (this.disposed || signal.aborted) return () => {}
    const end = (): void => {
      const index = this.waits.indexOf(wait)
      if (index < 0) return
      this.waits.splice(index, 1)
      signal.removeEventListener('abort', end)
      if (wait.timer !== undefined) clearTimeout(wait.timer)
      if (wait.shown) this.publishWait()
    }
    const wait: PromptWait = { message, end, shown: false, timer: undefined }
    this.waits.push(wait)
    signal.addEventListener('abort', end, { once: true })
    wait.timer = setTimeout(() => {
      wait.timer = undefined
      if (!this.waits.includes(wait)) return
      wait.shown = true
      this.publishWait()
    }, 150)
    return end
  }

  /** Clear this mount's facts and make queued editor/timer callbacks inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const wait of [...this.waits].reverse()) wait.end()
    if (this.recallKey !== '') this.ctx.emit('mayfly/prompt-recall-changed', undefined)
    if (this.hint !== undefined) this.ctx.emit('mayfly/prompt-hint-changed', undefined)
  }

  private publishWait(): void {
    this.ctx.emit('mayfly/prompt-wait-changed', this.waits.findLast(wait => wait.shown)?.message)
  }
}
