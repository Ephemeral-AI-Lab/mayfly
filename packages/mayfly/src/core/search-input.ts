/**
 * Shared single-line search input backed by the native editor's paste and
 * grapheme editing behavior. The terminal parser supplies a complete paste
 * start marker; content and the end marker may arrive in later chunks.
 * Raw terminal input stays inside core.
 * @module @ephemeral-ai/mayfly/core/search-input
 */
import { stripVTControlCharacters } from 'node:util'
import type { MayflyComponents, MayflyEditor } from './types.ts'

export class SearchInput {
  private readonly editor: MayflyEditor
  private pasteBuffer = ''
  private pasting = false

  constructor(components: MayflyComponents) {
    this.editor = components.createEditor()
  }

  get pending(): boolean { return this.pasting }
  get text(): string { return this.editor.getExpandedText() }
  clear(): void { this.editor.setText(''); this.pasteBuffer = ''; this.pasting = false }

  handleInput(data: string, backspace = false): boolean {
    const startsPaste = data.includes('\x1b[200~')
    if (!this.pasting && !startsPaste && !backspace && !/^[^\x00-\x1f\x7f-\x9f]+$/u.test(data)) return false
    if (startsPaste) this.pasting = true
    if (this.pasting) {
      this.pasteBuffer += data
      if (!this.pasteBuffer.includes('\x1b[201~')) return true
      const text = stripVTControlCharacters(this.pasteBuffer).replace(/[\r\n\t]+/gu, ' ').replace(/[\x00-\x1f\x7f-\x9f]/gu, '')
      this.editor.handleInput!(`\x1b[200~${text}\x1b[201~`)
      this.pasting = false
      this.pasteBuffer = ''
      return true
    }
    this.editor.handleInput!(backspace ? '\x7f' : data)
    return true
  }
}
