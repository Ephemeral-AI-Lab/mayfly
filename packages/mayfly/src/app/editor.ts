/**
 * Standalone remote editor with transient command feedback.
 * @module @ephemeral-ai/mayfly/app/editor
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeWheelInput } from '../core/terminal.ts'
import type { MayflyComponents, MayflyEditor, MayflySemanticColors } from '../core/types.ts'
import type { MayflyScreenService } from '../core/screen.ts'
import { memoizedLocaleTranslator } from '../frontend/locale.ts'
import { Editor } from '../components/editor.ts'
import { EditorExtensionRuntime } from '../frontend/editor-extension-runtime.ts'
import { mountInteractionLocale } from '../interaction/locale.ts'
import { placeholderLadder, placeholderState, type PlaceholderView } from '../interaction/placeholder.ts'
import { ui } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from './notice.ts'
import type { RemoteEditorPrepared } from './editor/types.ts'
import { RemoteNotifications, type RemoteNotificationPresentation } from './notifications.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The empty prompt requests the existing key-help surface. */
    'mayfly/request-help'(): void
  }
}

/** Local commands emitted by the small standalone remote editor. */
interface RemoteEditorActions {
  submit(text: string): void | Promise<void>
  onError(error: unknown): void
  cancel(): void
  exit(): void
}

/** Mounted editor, notice channel, and focus restoration handle. */
export interface RemoteEditorHandle {
  /** Actual shared editor engine used by the composition's feature attachment. */
  readonly editor: MayflyEditor
  /** The one shared extension shell mounted around this retained editor. */
  readonly extensions: EditorExtensionRuntime<RemoteEditorPrepared>
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
  readonly slashHint?: string | undefined
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
  const repaint = (): void => { screen.requestRender() }
  const extensions = new EditorExtensionRuntime<RemoteEditorPrepared>({
    ctx, editor, components: () => components, colors: () => colors,
    report: (id, feedback) => { notifications.report(id, feedback) },
    frame: ({ parked }) => {
      const facts = presentation()
      const title = (facts.title || (facts.view?.kind === 'primary' ? undefined : facts.view?.label))?.replace(/\s+/gu, ' ').trim() || undefined
      return Editor({
        ...title === undefined ? {} : { title }, shell: shellMode, parked,
        placeholder: placeholderLadder(placeholderState(facts.view, shellMode, facts.running === true), facts.quietHints === 'off', t),
      })
    },
    footer: () => {
      const hint = presentation().slashHint
      return hint === undefined ? undefined : ui.text(hint, { tone: 'muted' })
    },
  })
  const sync = (): void => {
    if (disposed) return
    notifications.refresh()
    extensions.refreshPresentation()
  }
  editor.onChange = () => {
    if (disposed) return
    notifications.clear()
    sync()
  }
  const originalShellMode = editor.setShellMode
  editor.setShellMode = next => {
    if (disposed) return
    originalShellMode?.call(editor, next)
    shellMode = next
    sync()
    repaint()
  }
  const slot = screen.mountDockSlot('editor.prompt', extensions)
  slot.focus()
  const offScroll = screen.setContentScrollHandler(data => {
    if (disposed || !extensions.focused) return false
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
  const refresh = (): void => { sync(); if (!disposed) repaint() }
  // All locale memo observers must see the revision before the frame reads them.
  const offLocale = ctx.mayflyLocale.subscribe(() => { queueMicrotask(refresh) })
  const offSettings = ctx.on('mayfly/settings-source-ready', refresh)
  const handle: RemoteEditorHandle = {
    editor,
    extensions,
    notice: notifications.notice,
    retheme(nextComponents, nextColors) {
      if (disposed) return
      if (components === nextComponents && colors === nextColors) return
      extensions.invalidateSession()
      notifications.clear()
      components = nextComponents
      colors = nextColors
      editor.updateColors(nextColors)
      notifications.refresh()
      extensions.refreshPresentation(true)
      repaint()
    },
    refresh,
    focus() { if (!disposed) slot.focus() },
    dispose() {
      if (disposed) return
      disposed = true
      editor.setShellMode = originalShellMode
      offLocale()
      offSettings()
      offScroll()
      extensions.dispose()
      notifications.dispose()
      slot.dispose()
    },
  }
  ctx.effect(() => () => { handle.dispose() })
  return handle
}
