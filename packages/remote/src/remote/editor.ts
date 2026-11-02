/**
 * Standalone remote editor with transient command feedback.
 * @module @ephemeral-ai/mayfly/remote/editor
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  compileMayflyEditorShellNode,
  type MayflyComponents,
  type MayflyEditor,
  type MayflyEditorShellComponent,
  type MayflyFocusable,
  type MayflyScreenService,
  type MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { Editor, mountInteractionLocale, placeholderLadder, placeholderState, type PlaceholderView } from '@ephemeral-ai/mayfly/editor-presentation'
import type { RemoteNotice } from './notice.ts'
import { RemoteNotifications, type RemoteNotificationPresentation } from './notifications.ts'

/** Local commands emitted by the small standalone remote editor. */
export interface RemoteEditorActions {
  submit(text: string): void | Promise<void>
  onError(error: unknown): void
  cancel(): void
  exit(): void
}

/** Mounted editor, notice channel, and focus restoration handle. */
export interface RemoteEditorHandle {
  /** Actual shared editor engine used by the composition's feature attachment. */
  readonly editor: MayflyEditor
  readonly notice: RemoteNotice
  /** Repaint the retained native editor and frame without replacing its state. */
  retheme(components: MayflyComponents, colors: MayflySemanticColors): void
  /** Re-read conversation facts after projection, locale, or view selection. */
  refresh(): void
  focus(): void
  dispose(): void
}

/** Current readonly conversation facts used by the shared reference editor. */
export interface RemoteEditorPresentation extends RemoteNotificationPresentation {
  readonly view?: PlaceholderView | undefined
  readonly title?: string | undefined
}

class RemoteEditorDock implements MayflyFocusable {
  private ownFocused = false
  constructor(
    private shell: MayflyEditorShellComponent,
    private readonly sync: () => void,
  ) {}

  get focused(): boolean { return this.ownFocused }
  set focused(value: boolean) {
    const changed = value !== this.ownFocused
    this.ownFocused = value
    this.shell.focused = value
    if (changed) this.sync()
  }

  setShell(shell: MayflyEditorShellComponent): void {
    this.shell.focused = false
    this.shell = shell
    shell.focused = this.ownFocused
  }

  handleInput(data: string): void {
    this.shell.handleInput?.(data)
  }

  render(width: number): string[] {
    this.sync()
    const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
    return this.shell.render(safeWidth)
  }

  invalidate(): void {
    this.shell.invalidate()
  }
}

/** Mount the standalone editor without any Host Agent, command registry, or Session object. */
export function mountRemoteEditor(
  ctx: Context,
  screen: MayflyScreenService,
  components: MayflyComponents,
  colors: MayflySemanticColors,
  actions: RemoteEditorActions,
  presentation: () => RemoteEditorPresentation = () => ({}),
): RemoteEditorHandle {
  const editor: MayflyEditor = components.createEditor()
  mountInteractionLocale(ctx)
  const t = memoizedLocaleTranslator(ctx, 'interaction').translate
  const notifications = new RemoteNotifications(ctx, presentation)
  editor.onSubmit = (value) => {
    const text = value.trim()
    if (text.length === 0) return
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
  let shellMode = false
  let frameShape = ''
  let dock: RemoteEditorDock | undefined
  let disposed = false
  const compile = (): MayflyEditorShellComponent | undefined => {
    const facts = presentation()
    const title = (facts.title || (facts.view?.kind === 'primary' ? undefined : facts.view?.label))?.replace(/\s+/gu, ' ').trim() || undefined
    const node = Editor({
      ...title === undefined ? {} : { title }, shell: shellMode, parked: dock !== undefined && !dock.focused,
      placeholder: placeholderLadder(placeholderState(facts.view, shellMode, facts.running === true), facts.quietHints === 'off', t),
    })
    const shape = JSON.stringify(node)
    if (frameShape === shape) return undefined
    const compiled = compileMayflyEditorShellNode(node, {
      editor, components, colors, getViewport: () => screen.editorViewport,
      screenMode: 'main', keymap: ctx.mayflyKeymap, emit: screen.requestRender.bind(screen),
    })
    if (!compiled.ok) throw new Error(compiled.message)
    frameShape = shape
    compiled.value.component.focusEditor()
    return compiled.value.component
  }
  const sync = (): void => {
    if (disposed) return
    notifications.refresh()
    const next = compile()
    if (next !== undefined) dock?.setShell(next)
  }
  const shell = compile()!
  shell.focusEditor()
  dock = new RemoteEditorDock(shell, sync)
  const originalShellMode = editor.setShellMode
  editor.setShellMode = next => {
    originalShellMode?.call(editor, next)
    shellMode = next
    sync()
    screen.requestRender()
  }
  const slot = screen.mountDockSlot('editor.prompt', dock)
  slot.focus()
  return {
    editor,
    notice: notifications.notice,
    retheme(nextComponents, nextColors) {
      if (disposed) return
      components = nextComponents
      colors = nextColors
      editor.updateColors(nextColors)
      frameShape = ''
      sync()
      screen.requestRender()
    },
    refresh() { sync(); if (!disposed) screen.requestRender() },
    focus() { slot.focus() },
    dispose() {
      if (disposed) return
      disposed = true
      editor.setShellMode = originalShellMode
      notifications.dispose()
      slot.dispose()
    },
  }
}
