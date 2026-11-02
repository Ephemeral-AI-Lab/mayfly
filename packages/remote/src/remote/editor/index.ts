/**
 * Mount Commands, Skills, autocomplete, full editor behavior, and Remote-local integrations.
 * @module @ephemeral-ai/mayfly/remote/editor
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { QueueAction, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type {
  MayflyAutocompleteProvider,
  MayflyComponent,
  MayflyFocusable,
} from '@ephemeral-ai/mayfly/core'
import { EditorAttachments } from './attachments.ts'
import { EditorAutocomplete } from './autocomplete.ts'
import { EditorCommands } from './commands.ts'
import { mentionPath, readHostFile as readWorkspaceFile } from './mentions.ts'
import { onAgentPresetSelected } from './official.ts'
import { EditorShell } from './shell.ts'
import { EditorSkills } from './skills.ts'
import { EditorSkillsPanel } from './skills-panel.ts'
import { EditorSubmit } from './submit.ts'
import { EditorDraftStore, errorMessage } from './utils.ts'
import { copyLocalText } from '../local/clipboard.ts'
import { editLocalText, resolveExternalEditorCommand } from '../local/external-editor.ts'
import { clipboardFailureNotice, LocalImagePaste } from '../local/image-paste.ts'
import { LocalProcessOwner } from '../local/process.ts'
import { remotePanelOverlayOptions } from '../panels.ts'
import type {
  EditorFeatureController,
  EditorFeatureOptions,
  EditorFeatureSession,
  EditorHostFileSnapshot,
  EditorToken,
} from './types.ts'

export {
  EDITOR_INTEGRATION_REQUIREMENTS,
  type EditorCommandDescriptor,
  type EditorFeatureController,
  type EditorFeatureOptions,
  type EditorFeatureSession,
  type EditorHostFileBytes,
  type EditorHostFiles,
  type EditorHostFileSnapshot,
  type EditorHostFileStat,
  type EditorLocalAdapter,
  type EditorLocalCommandInvocation,
  type EditorLocalCommandResult,
  type EditorToken,
  type EditorTokenSpan,
  type EditorUpload,
} from './types.ts'
export { EditorDraftStore, parseEditorCommand, filterEditorCommands } from './utils.ts'
export { activeMention, applyMention, formatMention, mentionPath } from './mentions.ts'
export { extractSkillPrefix, rewriteSkillTokens } from './skills.ts'
export { imageMarker, sniffImageMediaType } from './attachments.ts'
export { sanitizeShellOutput } from './shell.ts'
export { copyLocalText } from '../local/clipboard.ts'
export { editLocalText, resolveExternalEditorCommand } from '../local/external-editor.ts'

const EMPTY_PROVIDER: MayflyAutocompleteProvider = {
  getSuggestions: () => Promise.resolve(null),
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines: [...lines], cursorLine, cursorCol }),
}

function fallbackTranslate(key: string, values?: Readonly<Record<string, string | number>>): string {
  return key.replace(/\{([^}]+)\}/gu, (_, name: string) => String(values?.[name] ?? `{${name}}`))
}

function selectionKey(selected: EditorFeatureSession | undefined): string {
  return selected === undefined ? '' : `${selected.ref.host}\0${selected.ref.sessionId}\0${String(selected.generation)}`
}

class ImagePreview implements MayflyFocusable {
  focused = false
  constructor(private readonly image: MayflyComponent, private readonly close: () => void) {}
  handleInput(data: string): void {
    if (data === '\x1b' || data === '\x03' || data === 'q' || data === 'Q') this.close()
  }
  render(width: number): string[] { return this.image.render(width) }
  invalidate(): void { this.image.invalidate() }
}

/**
 * Attach one feature generation to the actual MayflyEditor. The foundation transfers
 * onSubmit ownership to this controller and calls selectionChanged/hostReconnected
 * from its exact Session and lifecycle observations.
 */
export function attachEditorFeatures(options: EditorFeatureOptions): EditorFeatureController {
  const t = options.t ?? fallbackTranslate
  const editor = options.editor
  const draft = options.draft ?? new EditorDraftStore()
  let mode: 'prompt' | 'bash' = draft.currentMode()
  let disposed = false
  let routeLifetime = new AbortController()
  let routeKey = selectionKey(options.session())
  let offCommands: (() => void) | undefined
  let offPreset: (() => void) | undefined
  let preview: { hide(): void } | undefined
  let pasteRunning = false
  let externalRunning = false
  let lastInterruptAt = 0
  const processes = new LocalProcessOwner()
  const commands = new EditorCommands({ session: options.session, local: options.local, notice: options.notice, t })
  const skills = new EditorSkills(options.session)
  const attachments = new EditorAttachments(options.components, options.upload)
  const autocomplete = new EditorAutocomplete({
    session: options.session,
    commands,
    skills,
    components: options.components,
    notice: options.notice,
    t,
    bash: () => mode === 'bash',
  })
  const submit = new EditorSubmit({
    editor,
    screen: options.screen,
    session: options.session,
    ...options.ensureSession === undefined ? {} : { ensureSession: options.ensureSession },
    commands,
    skills,
    attachments,
    draft,
    notice: options.notice,
    t,
    exit: options.local.exit,
  })
  const panel = new EditorSkillsPanel({
    skills,
    screen: options.screen,
    components: options.components,
    colors: options.colors,
    t,
    restoreFocus: () => { options.screen.setFocus(editor) },
  })
  const shell = new EditorShell(options.screen, options.components, options.colors, t)
  const imagePaste = new LocalImagePaste(() => options.local.clipboardBackend?.() ?? 'auto')

  const previousChange = editor.onChange
  const previousSubmit = editor.onSubmit
  const previousKey = editor.onKey
  const previousTokenChange = editor.onTokenChange

  const closePreview = (): void => {
    preview?.hide()
    preview = undefined
    if (!disposed) options.screen.setFocus(editor)
  }

  const syncGhosts = (): void => {
    if (disposed) return
    editor.setGhostHint(autocomplete.ghost(editor.getText()))
    options.screen.requestRender()
  }

  const setMode = (next: 'prompt' | 'bash'): void => {
    mode = next
    draft.stashMode(next)
    editor.setShellMode(next === 'bash')
    syncGhosts()
  }

  const bindHost = (): void => {
    offCommands?.()
    offPreset?.()
    offCommands = undefined
    offPreset = undefined
    const selected = options.session()
    if (selected === undefined) return
    offCommands = selected.client.remote.$on('commands/change', () => {
      if (!disposed && options.session()?.client === selected.client) void commands.refresh()
    })
    offPreset = onAgentPresetSelected(selected.client, (sessionId) => {
      const current = options.session()
      if (!disposed && current?.client === selected.client && current.ref.sessionId === sessionId) controller.presetChanged()
    })
  }

  const selectionChanged = (): void => {
    if (disposed) return
    routeKey = selectionKey(options.session())
    routeLifetime.abort()
    routeLifetime = new AbortController()
    autocomplete.invalidate()
    commands.syncSelection()
    skills.syncSelection()
    panel.close()
    closePreview()
    bindHost()
    void commands.refresh()
    void skills.refresh()
    syncGhosts()
  }

  const detectSelection = (): void => {
    const key = selectionKey(options.session())
    if (key !== routeKey) selectionChanged()
  }

  const restoreSubmissionDraft = (): void => {
    submit.stashDraft()
    autocomplete.invalidate()
    syncGhosts()
  }

  const openHostMention = async (mention: string): Promise<void> => {
    const selected = options.session()
    if (selected === undefined) {
      options.notice.set(t('no active session'))
      return
    }
    const operation = processes.operation(routeLifetime.signal)
    try {
      const result = await options.files.openWorkspacePath(mentionPath(mention), operation.signal)
      if (!result.ok && !disposed && !operation.signal.aborted) options.notice.set(result.error.message)
    } catch (error) {
      if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'could not open the Host path'))
    } finally {
      operation.done()
    }
  }

  const showImage = (token: EditorToken): void => {
    const image = attachments.image(token.text)
    if (image === undefined) return
    closePreview()
    const component = options.components.createImage({
      data: image.data,
      mediaType: image.mediaType,
      filename: image.name,
      maxHeightCells: Math.max(4, Math.min(40, options.screen.rows - 6)),
    })
    const handle = options.screen.showOverlay(new ImagePreview(component, closePreview), remotePanelOverlayOptions(options.screen, { maxHeight: '90%' }))
    preview = handle
  }

  const editDraft = async (): Promise<void> => {
    if (externalRunning || disposed) return
    const command = resolveExternalEditorCommand(process.env, options.local.editorCommand?.() ?? '')
    if (command === undefined) {
      options.notice.set(t('set $VISUAL or $EDITOR to edit drafts externally'))
      return
    }
    externalRunning = true
    const operation = processes.operation(routeLifetime.signal)
    const pasted = [...(editor.captureDraft?.().pastes.values() ?? [])]
    try {
      await options.screen.suspend(async () => {
        const edited = await editLocalText(editor.getExpandedText(), command, operation.signal)
        if (edited === undefined || disposed || operation.signal.aborted) return
        editor.setTextFolding(edited.replaceAll('\r\n', '\n').replace(/\n$/u, ''), pasted)
        restoreSubmissionDraft()
      })
    } catch (error) {
      if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'external editor failed'))
    } finally {
      operation.done()
      externalRunning = false
    }
  }

  const editToken = async (token: EditorToken): Promise<void> => {
    if (token.kind === 'mention') {
      await openHostMention(token.text)
      return
    }
    if (externalRunning || disposed) return
    const command = resolveExternalEditorCommand(process.env, options.local.editorCommand?.() ?? '')
    if (command === undefined) {
      options.notice.set(t('set $VISUAL or $EDITOR to edit drafts externally'))
      return
    }
    externalRunning = true
    const operation = processes.operation(routeLifetime.signal)
    try {
      await options.screen.suspend(async () => {
        const edited = await editLocalText(token.content ?? token.text, command, operation.signal)
        if (edited === undefined || disposed || operation.signal.aborted) return
        editor.replaceActiveToken(edited.replaceAll('\r\n', '\n').replace(/\n$/u, ''))
        restoreSubmissionDraft()
      })
    } catch (error) {
      if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'external editor failed'))
    } finally {
      operation.done()
      externalRunning = false
    }
  }

  const pasteImage = async (): Promise<void> => {
    if (pasteRunning || disposed) return
    const selected = options.session()
    const limits = attachments.limits(selected)
    if (selected === undefined || limits === undefined) {
      options.notice.set(t('image limits are unavailable for the selected Session'))
      return
    }
    pasteRunning = true
    const operation = processes.operation(routeLifetime.signal)
    try {
      const result = await imagePaste.read(limits, operation.signal)
      if (disposed || operation.signal.aborted) return
      if (result.kind !== 'image' && result.kind !== 'images') {
        options.notice.set(t(clipboardFailureNotice(result)))
        return
      }
      const images = result.kind === 'image'
        ? [{ data: result.data, mediaType: result.mediaType, name: undefined }]
        : result.images
      const markers = images.map(image => attachments.addImage(
        selected,
        image.data,
        image.mediaType,
        image.name,
      ))
      editor.insertText(markers.join(' '))
      submit.stashDraft()
      if (result.fallback === true && result.backend !== undefined) {
        const backend = result.backend === 'x11' ? 'X11' : 'Wayland'
        options.notice.set(`pasted image via ${backend} fallback; verify it is current`)
      } else options.notice.set(`pasted ${String(markers.length)} image${markers.length === 1 ? '' : 's'}`)
    } catch (error) {
      if (!disposed && !operation.signal.aborted) options.notice.set(t('image rejected: {error}', { error: errorMessage(error) }))
    } finally {
      operation.done()
      pasteRunning = false
    }
  }

  const controller: EditorFeatureController = {
    selectionChanged,
    hostReconnected() {
      selectionChanged()
    },
    presetChanged() {
      if (disposed) return
      autocomplete.invalidate()
      void commands.refresh()
      void skills.refresh().then(() => {
        if (!disposed && panel.open) options.screen.requestRender()
      })
    },
    async refreshCommands() {
      detectSelection()
      await commands.refresh()
    },
    async refreshSkills() {
      detectSelection()
      await skills.refresh()
      if (!disposed) options.screen.requestRender()
    },
    async openSkills() {
      detectSelection()
      if (options.session() === undefined) {
        options.notice.set(t('no active session'))
        return
      }
      await panel.show()
    },
    updateQueue(itemId: MessageId, action: QueueAction): Promise<boolean> {
      detectSelection()
      return submit.updateQueue(itemId, action)
    },
    restoreQueued(text: string): void {
      detectSelection()
      submit.restoreQueued(text)
    },
    requeue(text: string, lane: 'turn' | 'step'): void {
      detectSelection()
      submit.requeue(text, lane)
    },
    async openText(text: string): Promise<void> {
      if (externalRunning || disposed) return
      const command = resolveExternalEditorCommand(process.env, options.local.editorCommand?.() ?? '')
      if (command === undefined) {
        options.notice.set(t('set $VISUAL or $EDITOR to edit drafts externally'))
        return
      }
      externalRunning = true
      const operation = processes.operation(routeLifetime.signal)
      try {
        await options.screen.suspend(async () => { await editLocalText(text, command, operation.signal) })
      } catch (error) {
        if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'external editor failed'))
      } finally {
        operation.done()
        externalRunning = false
      }
    },
    async readAttachment(attachment: ImageAttachmentRef): Promise<Uint8Array | undefined> {
      detectSelection()
      const selected = options.session()
      if (selected === undefined) return undefined
      const operation = processes.operation(routeLifetime.signal)
      try {
        const data = await attachments.read(selected, attachment)
        return disposed || operation.signal.aborted ? undefined : data
      } catch (error) {
        if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'attachment read failed'))
        return undefined
      } finally {
        operation.done()
      }
    },
    imageLimits() {
      detectSelection()
      return attachments.limits(options.session())
    },
    async stageFile(data: Uint8Array, name?: string): Promise<FileUploadValue | undefined> {
      detectSelection()
      const selected = options.session()
      if (selected === undefined) {
        options.notice.set(t('no active session'))
        return undefined
      }
      const operation = processes.operation(routeLifetime.signal)
      try {
        const uploaded = await attachments.stageFile(selected, data, name, operation.signal)
        if (disposed || operation.signal.aborted) return undefined
        editor.insertText(attachments.addFile(uploaded))
        submit.stashDraft()
        options.notice.set(t('attached {name}', { name: uploaded.file.name }))
        return uploaded
      } catch (error) {
        if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'file upload failed'))
        return undefined
      } finally {
        operation.done()
      }
    },
    async readHostFile(path: string): Promise<EditorHostFileSnapshot | undefined> {
      detectSelection()
      const selected = options.session()
      if (selected === undefined) return undefined
      const operation = processes.operation(routeLifetime.signal)
      try {
        const snapshot = await readWorkspaceFile(selected, options.files, path, operation.signal)
        return disposed || operation.signal.aborted ? undefined : snapshot
      } catch (error) {
        if (!disposed && !operation.signal.aborted) options.notice.set(errorMessage(error, 'Host file read failed'))
        return undefined
      } finally {
        operation.done()
      }
    },
    async copyText(text: string): Promise<'native' | 'osc52'> {
      const operation = processes.operation(routeLifetime.signal)
      try {
        return await copyLocalText(text, operation.signal)
      } finally {
        operation.done()
      }
    },
    skills(): readonly SkillEntry[] {
      detectSelection()
      return skills.list()
    },
    dispose() {
      if (disposed) return
      disposed = true
      offCommands?.()
      offPreset?.()
      offCommands = undefined
      offPreset = undefined
      routeLifetime.abort()
      processes.dispose()
      panel.close()
      preview?.hide()
      preview = undefined
      autocomplete.dispose()
      submit.dispose()
      attachments.dispose()
      shell.dispose()
      unregisterPaste()
      editor.onChange = previousChange
      editor.onSubmit = previousSubmit
      editor.onKey = previousKey
      editor.onTokenChange = previousTokenChange
      editor.setAutocompleteProvider(EMPTY_PROVIDER)
      editor.setTokenSource(undefined)
      editor.setSubmitBarrier(undefined)
      editor.setGhostHint(undefined)
      editor.setShellMode(false)
    },
  }

  const unregisterPaste = options.keymap.register([{
    id: 'mayfly.image.paste',
    keys: ['ctrl+v'],
    scope: 'editor',
    description: t('Paste a clipboard image into the prompt'),
  }])

  editor.setAutocompleteProvider(autocomplete.source())
  editor.setTokenSource(line => [...attachments.tokenSpans(line), ...autocomplete.tokenSpans(line)]
    .toSorted((left, right) => left.start - right.start))
  editor.onTokenChange = token => { previousTokenChange?.(token) }
  editor.onChange = text => {
    previousChange?.(text)
    if (disposed) return
    detectSelection()
    autocomplete.invalidate()
    if (mode === 'prompt' && text === '!') {
      setMode('bash')
      editor.setText('')
      editor.setGhostHint(undefined)
      return
    }
    submit.stashDraft()
    editor.setGhostHint(autocomplete.ghost(text))
    if (/(?:^|\s)#/u.test(text)) void skills.refresh()
  }
  editor.onSubmit = value => {
    if (disposed) return
    detectSelection()
    if (mode === 'bash') {
      setMode('prompt')
      const command = value.trim()
      editor.setText('')
      if (command.length === 0) return
      editor.addToHistory(command)
      submit.stashHistory()
      shell.run(command, options.local.cwd())
      return
    }
    submit.submit(value)
  }
  editor.onKey = data => {
    if (disposed) return false
    detectSelection()
    const running = options.session()?.session.getSnapshot().running === true
    if (options.keymap.matches(data, 'mayfly.interaction.backspace') && editor.tokenBackspace()) return true
    if (options.keymap.matches(data, 'mayfly.image.paste')) {
      void pasteImage()
      return true
    }
    if (options.keymap.matches(data, 'ui.accept') && editor.isShowingAutocomplete()) {
      const view = editor.completion()
      const item = view?.kind === 'files' ? view.items[view.index] : undefined
      if (item !== undefined && item.label.endsWith('/')) {
        editor.handleInput?.('\t')
        if (item.value.endsWith('"') || item.value.endsWith("'")) editor.handleInput?.('\x1b[C')
        editor.insertText(' ')
        autocomplete.acceptDirectory(item.value)
        editor.refreshAutocomplete()
        return true
      }
    }
    if (options.keymap.matches(data, 'ui.external')) {
      const view = editor.isShowingAutocomplete() ? editor.completion() : undefined
      const row = view?.kind === 'files' ? view.items[view.index] : undefined
      if (row !== undefined && !row.label.endsWith('/')) {
        void openHostMention(row.value)
        return true
      }
      const token = editor.activeToken()
      if (token?.kind === 'image') {
        showImage(token)
        return true
      }
      if (token !== undefined) {
        void editToken(token)
        return true
      }
      void editDraft()
      return true
    }
    if (options.keymap.matches(data, 'ui.cancel')) {
      if (editor.isShowingAutocomplete()) return false
      if (running) {
        void submit.cancel()
        return true
      }
      if (mode === 'bash' && editor.getText().length === 0) {
        setMode('prompt')
        return true
      }
      return submit.clearDraft() || previousKey?.(data) === true
    }
    if (options.keymap.matches(data, 'mayfly.interaction.interrupt')) {
      if (submit.clearDraft()) return true
      if (running) {
        void submit.cancel()
        return true
      }
      const now = Date.now()
      if (now - lastInterruptAt < 1_000) {
        lastInterruptAt = 0
        void options.local.exit()
        return true
      }
      lastInterruptAt = now
      options.notice.set(t('press Ctrl+C again to exit'))
      return true
    }
    if (options.keymap.matches(data, 'mayfly.interaction.steer')) {
      if (editor.getText().trim().length === 0) return previousKey?.(data) ?? false
      return submit.steer()
    }
    return previousKey?.(data) ?? false
  }

  submit.restoreEditor()
  setMode(mode)
  bindHost()
  void commands.refresh()
  void skills.refresh()
  return controller
}
