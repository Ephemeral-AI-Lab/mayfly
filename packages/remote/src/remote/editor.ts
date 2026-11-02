/**
 * Standalone remote editor with transient command feedback.
 * @module @ephemeral-ai/mayfly/remote/editor
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  compileMayflyEditorShellNode,
  normalizeWheelInput,
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

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The empty prompt requests the existing key-help surface. */
    'mayfly/request-help'(): void
  }
}

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
  let disposed = false
  mountInteractionLocale(ctx)
  const t = memoizedLocaleTranslator(ctx, 'interaction').translate
  const notifications = new RemoteNotifications(ctx, presentation)
  editor.onSubmit = (value) => {
    if (disposed) return
    const text = value.trim()
    if (text.length === 0) return
    editor.addToHistory(value)
    void Promise.resolve(actions.submit(text)).catch((error: unknown) => { if (!disposed) actions.onError(error) })
  }
  editor.onKey = (data) => {
    if (disposed) return false
    if (data === '?' && editor.getText().length === 0 && !shellMode && !editor.isShowingAutocomplete()) {
      ctx.emit('mayfly/request-help')
      return true
    }
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
    if (ctx.mayflyKeymap.matches(data, 'ui.focus-next')
      && editor.getText().length === 0
      && !editor.isShowingAutocomplete()
      && screen.enterViews()) return true
    if (ctx.mayflyKeymap.matches(data, 'ui.focus-prev')
      && !editor.isShowingAutocomplete()
      && screen.focusConversation()) return true
    return false
  }
  let shellMode = false
  let frameShape = ''
  let dock: RemoteEditorDock | undefined
  const repaint = (): void => { screen.requestRender() }
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
      screenMode: 'main', keymap: ctx.mayflyKeymap, emit: repaint,
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
    if (disposed) return
    originalShellMode?.call(editor, next)
    shellMode = next
    sync()
    repaint()
  }
  const slot = screen.mountDockSlot('editor.prompt', dock)
  slot.focus()
  const offScroll = screen.setContentScrollHandler(data => {
    if (disposed || !dock!.focused) return false
    const wheel = normalizeWheelInput(data)
    if (wheel !== undefined) {
      const direction = ctx.mayflyKeymap.matches(wheel, 'ui.up')
        ? 'up' : ctx.mayflyKeymap.matches(wheel, 'ui.down') ? 'down' : undefined
      if (direction === undefined) return false
      screen.scrollContent(direction, 3)
      return true
    }
    const pageUp = ctx.mayflyKeymap.matches(data, 'ui.page-up')
    const pageDown = ctx.mayflyKeymap.matches(data, 'ui.page-down')
    if (pageUp || pageDown) return screen.scrollContent(pageUp ? 'up' : 'down', Math.max(1, screen.rows - 4))
    if (ctx.mayflyKeymap.matches(data, 'mayfly.interaction.follow-tail')) {
      ctx.emit('mayfly/request-new-messages')
      return true
    }
    if (editor.getText().length > 0) return false
    if (ctx.mayflyKeymap.matches(data, 'ui.end')) {
      screen.followContent()
      return true
    }
    return false
  })
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
      repaint()
    },
    refresh() { sync(); if (!disposed) repaint() },
    focus() { if (!disposed) slot.focus() },
    dispose() {
      if (disposed) return
      disposed = true
      editor.setShellMode = originalShellMode
      offScroll()
      notifications.dispose()
      slot.dispose()
    },
  }
}
