/**
 * Standalone remote editor with transient command feedback.
 * @module @ephemeral-ai/mayfly/remote/editor
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  compileMayflyEditorShellNode,
  type MayflyComponent,
  type MayflyComponents,
  type MayflyEditor,
  type MayflyEditorShellComponent,
  type MayflyFocusable,
  type MayflyScreenService,
  type MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import { ui } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from './notice.ts'

/** Local commands emitted by the small standalone remote editor. */
export interface RemoteEditorActions {
  submit(text: string): void | Promise<void>
  onError(error: unknown): void
  cancel(): void
  exit(): void
}

/** Mounted editor, notice channel, and focus restoration handle. */
export interface RemoteEditorHandle {
  readonly notice: RemoteNotice
  focus(): void
  dispose(): void
}

class RemoteHint implements MayflyComponent {
  private text = ''

  constructor(
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
  ) {}

  set(text: string): void {
    this.text = text
  }

  render(width: number): string[] {
    if (this.text === '') return []
    const rows = this.text.split(/\r\n?|\n/u).flatMap(line => this.components.wrapText(line.trim(), Math.max(1, width)))
    return rows.slice(0, 8).map(row => this.colors.muted(this.components.truncateToWidth(row, width)))
  }

  invalidate(): void {}
}

class RemoteEditorDock implements MayflyFocusable {
  constructor(
    private readonly shell: MayflyEditorShellComponent,
    private readonly hint: RemoteHint,
  ) {}

  get focused(): boolean { return this.shell.focused }
  set focused(value: boolean) { this.shell.focused = value }

  handleInput(data: string): void {
    this.shell.handleInput?.(data)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
    return [...this.shell.render(safeWidth), ...this.hint.render(safeWidth)]
  }

  invalidate(): void {
    this.shell.invalidate()
    this.hint.invalidate()
  }
}

/** Mount the standalone editor without any Host Agent, command registry, or Session object. */
export function mountRemoteEditor(
  ctx: Context,
  screen: MayflyScreenService,
  components: MayflyComponents,
  colors: MayflySemanticColors,
  actions: RemoteEditorActions,
): RemoteEditorHandle {
  const editor: MayflyEditor = components.createEditor()
  const hint = new RemoteHint(components, colors)
  editor.onChange = () => { hint.set('') }
  editor.onSubmit = (value) => {
    const text = value.trim()
    if (text.length === 0) return
    hint.set('')
    editor.addToHistory(value)
    void Promise.resolve(actions.submit(text)).catch((error: unknown) => { actions.onError(error) })
  }
  editor.onKey = (data) => {
    if (data === '\x03') {
      if (editor.getText().length > 0) {
        editor.setText('')
        return true
      }
      actions.exit()
      return true
    }
    if (data === '\x1b') {
      if (editor.getText().length > 0) editor.setText('')
      else actions.cancel()
      return true
    }
    return false
  }
  const compiled = compileMayflyEditorShellNode(ui.surface({
    chrome: 'surface',
    hint: 'completions',
    titleAlign: 'right',
    titleCut: 'end',
    child: ui.prompt({
      id: 'prompt',
      symbol: '> ',
      placeholder: ['Ask anything · / commands', 'Ask anything'],
    }),
  }), {
    editor,
    components,
    colors,
    getViewport: () => screen.editorViewport,
    screenMode: 'main',
    keymap: ctx.mayflyKeymap,
    emit: () => {},
  })
  if (!compiled.ok) throw new Error(compiled.message)
  const shell = compiled.value.component
  shell.focusEditor()
  const slot = screen.mountDockSlot('editor.prompt', new RemoteEditorDock(shell, hint))
  slot.focus()
  return {
    notice: {
      set(text) {
        hint.set(text)
        screen.requestRender()
      },
    },
    focus() { slot.focus() },
    dispose() { slot.dispose() },
  }
}
