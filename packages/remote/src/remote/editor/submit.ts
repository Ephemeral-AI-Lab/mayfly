/**
 * Single-use command/prompt submission, reversible drafts, and official queue writes.
 * @module @ephemeral-ai/mayfly/remote/editor/submit
 */

import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { PromptContentPart, QueueAction } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  MayflyEditor,
  MayflyScreen,
  MayflySubmittedDraft,
} from '@ephemeral-ai/mayfly/core'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from '../notice.ts'
import type { EditorAttachments, CapturedAttachments } from './attachments.ts'
import type { EditorCommands } from './commands.ts'
import type { EditorSkills } from './skills.ts'
import type { EditorDraftStore } from './utils.ts'
import { errorMessage, parseEditorCommand } from './utils.ts'
import type { EditorFeatureSession, RemoteEditorPrepared } from './types.ts'

interface SubmitOptions {
  readonly editor: MayflyEditor
  readonly screen: MayflyScreen
  readonly session: () => EditorFeatureSession | undefined
  readonly ensureSession?: () => Promise<EditorFeatureSession>
  /** Complete startup preparation after capturing the exact admitted binding. */
  readonly preparePrompt?: (selected: EditorFeatureSession, signal: AbortSignal, intent?: 'plan') => Promise<void>
  readonly commands: EditorCommands
  readonly skills: EditorSkills
  readonly attachments: EditorAttachments
  readonly draft: EditorDraftStore
  /** Restore focus through the mounted editor shell, when the frontend owns one. */
  readonly focusEditor?: () => void
  readonly notice: RemoteNotice
  readonly t: MayflyTranslate
  readonly exit: () => void | Promise<void>
  /** Consume an extension result while retaining the native source's history and draft snapshot. */
  readonly prepared?: (source: string) => RemoteEditorPrepared | undefined
}

interface SubmissionRecord {
  readonly id: number
  selected: EditorFeatureSession | undefined
  readonly source: string
  readonly historyText?: string
  readonly submitted: MayflySubmittedDraft
  readonly rollback: () => void
  accepted: boolean
}

function emptyDraft(text: string): MayflySubmittedDraft {
  return { raw: text, pastes: new Map() }
}

/** Owns submission identity and restoration; it never retries an admitted or ambiguous write. */
export class EditorSubmit {
  private readonly operations = new Set<AbortController>()
  private readonly records = new Map<number, SubmissionRecord>()
  private sequence = 0
  private latest: SubmissionRecord | undefined
  private disposed = false

  constructor(private readonly options: SubmitOptions) {}

  /** Restore draft/history into a newly mounted editor without replaying old submissions. */
  restoreEditor(): void {
    const editor = this.options.editor
    const stashed = this.options.draft.currentDraft()
    if (stashed.raw.length > 0) {
      if (editor.restoreSubmittedDraft !== undefined) editor.restoreSubmittedDraft(stashed)
      else editor.setText(stashed.raw)
    }
    const history = this.options.draft.currentHistory()
    const pastes = this.options.draft.currentHistoryPastes()
    for (let index = history.length - 1; index >= 0; index -= 1) editor.addToHistory(history[index]!, pastes[index])
  }

  stashDraft(): void {
    const editor = this.options.editor
    this.options.draft.stashDraft(editor.captureDraft?.() ?? emptyDraft(editor.getText()))
  }

  stashHistory(): void {
    this.options.draft.stashHistory(this.options.editor.getHistory(), this.options.editor.getHistoryPastes())
  }

  /** Clear a draft into one-Up history, preserving native paste and undo behavior elsewhere. */
  clearDraft(): boolean {
    const text = this.options.editor.getText()
    if (text.length === 0) return false
    this.options.editor.addToHistory(text)
    this.stashHistory()
    this.options.editor.setText('')
    this.options.draft.clearDraft()
    this.options.notice.set(this.options.t('draft cleared · ↑ restores'))
    this.options.screen.requestRender()
    return true
  }

  /** Native Enter path; the editor has captured the draft and cleared its buffer already. */
  submit(value: string): void {
    const line = value.trim()
    const prepared = this.options.prepared?.(value)
    const submitted = this.options.editor.consumeSubmittedDraft?.() ?? emptyDraft(value)
    this.options.draft.clearDraft()
    if (line.length === 0) return
    const historyText = submitted.raw.trim()
    this.options.editor.addToHistory(historyText, submitted.pastes)
    this.stashHistory()
    this.begin(line, 'queue', submitted, historyText, prepared?.captured)
  }

  /** Ctrl+Enter path; unlike Enter it bypasses the native funnel but uses the same transforms and request identity. */
  steer(): boolean {
    const value = this.options.editor.getExpandedText().trim()
    if (value.length === 0) return false
    const submitted = this.options.editor.captureDraft?.() ?? emptyDraft(value)
    this.options.editor.setText('')
    this.options.draft.clearDraft()
    this.begin(value, 'steer', submitted)
    return true
  }

  /** Restore a removed queue draft without submitting it. */
  restoreQueued(text: string): void {
    if (text.length === 0) return
    this.options.editor.setText(text)
    this.stashDraft()
    if (this.options.focusEditor !== undefined) this.options.focusEditor()
    else this.options.screen.setFocus(this.options.editor)
    this.options.screen.requestRender()
  }

  /** Explicit queue undo is a fresh prompt/request identity in the original lane, never a same-message replay. */
  requeue(text: string, lane: 'turn' | 'step'): void {
    if (text.trim().length === 0) return
    this.begin(text.trim(), lane === 'step' ? 'steer' : 'queue', emptyDraft(text))
  }

  /** Ordinary cancellation only; this method is deliberately not a claimed-turn retraction. */
  async cancel(): Promise<boolean> {
    const selected = this.options.session()
    if (selected === undefined) return false
    if (selected.access === 'readonly') return false
    try {
      const result = await selected.session.cancel()
      if (!result.ok) {
        if (!this.disposed && this.isCurrent(selected)) this.options.notice.set(result.error.message)
        return false
      }
      if (!this.disposed && this.isCurrent(selected)) this.options.notice.set(this.options.t('interrupt requested'))
      return true
    } catch (error) {
      if (!this.disposed && this.isCurrent(selected)) this.options.notice.set(errorMessage(error, 'interrupt failed'))
      return false
    }
  }

  /** Apply one official pending Inbox edit/remove/steer mutation once. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<boolean> {
    const selected = this.options.session()
    if (selected === undefined) {
      this.options.notice.set(this.options.t('no active session'))
      return false
    }
    if (selected.access === 'readonly') return false
    try {
      const result = await selected.session.updateQueue(itemId, action)
      if (!result.ok) {
        if (!this.disposed && this.isCurrent(selected)) this.options.notice.set(result.error.message)
        return false
      }
      return !this.disposed && this.isCurrent(selected)
    } catch (error) {
      if (!this.disposed && this.isCurrent(selected)) this.options.notice.set(errorMessage(error, 'queue update failed'))
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.operations) controller.abort()
    this.operations.clear()
    for (const record of this.records.values()) {
      if (!record.accepted) record.rollback()
    }
    this.records.clear()
  }

  private begin(
    source: string,
    mode: 'queue' | 'steer',
    submitted: MayflySubmittedDraft,
    historyText?: string,
    prepared?: CapturedAttachments,
  ): void {
    const selected = this.options.session()
    const captured = prepared ?? this.options.attachments.capture(source)
    const record: SubmissionRecord = {
      id: ++this.sequence,
      selected,
      source,
      ...historyText === undefined ? {} : { historyText },
      submitted,
      rollback: captured.rollback,
      accepted: false,
    }
    this.latest = record
    this.records.set(record.id, record)
    const controller = new AbortController()
    this.operations.add(controller)
    void this.deliver(record, captured, mode, controller).finally(() => {
      this.operations.delete(controller)
    })
  }

  private async deliver(
    record: SubmissionRecord,
    captured: CapturedAttachments,
    mode: 'queue' | 'steer',
    controller: AbortController,
  ): Promise<void> {
    try {
      const parsed = parseEditorCommand(record.source)
      if (parsed !== undefined && mode === 'queue') {
        const attachments = captured.content.filter(part => part.type !== 'text')
        const line = captured.content.filter(part => part.type === 'text').map(part => part.text).join('').trim()
        const input = line.slice(parsed.name.length + 1).trim()
        if (parsed.name === 'plan' && record.selected === undefined
          && (input !== '' && input !== 'off' || attachments.length > 0)) {
          record.selected = await this.options.ensureSession?.()
          if (this.disposed || controller.signal.aborted || !this.isCurrent(record.selected)) { this.fail(record, false); return }
        }
        captured.assertFileScope(record.selected)
        if (parsed.name === 'plan' && record.selected !== undefined
          && (input !== 'off' || attachments.length === 0) && this.options.preparePrompt !== undefined) {
          await this.options.preparePrompt(record.selected, controller.signal, 'plan')
          if (this.disposed || controller.signal.aborted || !this.isCurrent(record.selected)) { this.fail(record, false); return }
        }
        const result = await this.options.commands.execute(line, attachments, controller.signal)
        if (!result.accepted) {
          this.fail(record, false)
          return
        }
        this.records.delete(record.id)
        if (result.exit) await this.options.exit()
        return
      }
      const selected = record.selected ?? await this.options.ensureSession?.()
      if (this.disposed || controller.signal.aborted) { this.fail(record, false); return }
      record.selected = selected
      if (selected === undefined) {
        this.options.notice.set(this.options.t('Select or create a Session before prompting'))
        this.fail(record, false)
        return
      }
      if (selected.access === 'readonly') {
        this.options.notice.set(this.options.t('This conversation is read-only'))
        this.fail(record, false)
        return
      }
      captured.assertFileScope(selected)
      if (this.options.preparePrompt !== undefined) await this.options.preparePrompt(selected, controller.signal)
      if (this.disposed || controller.signal.aborted || !this.isCurrent(selected)) { this.fail(record, false); return }
      const content = captured.content.map((part): PromptContentPart => part.type === 'text'
        ? { ...part, text: this.options.skills.rewrite(part.text) }
        : part)
      // begin() admits nonempty source; marker capture replaces it with parts and skill rewriting never erases text.
      const text = content.filter(part => part.type === 'text').map(part => part.text).join('')
      const submission = selected.session.beginSubmission({
        mode,
        text,
        attachments: captured.pending,
        onAccept: () => { record.accepted = true },
        onRetire: retirement => {
          if (retirement.reason === 'observed') this.records.delete(record.id)
        },
      })
      try {
        const result = await selected.session.prompt(content, mode, controller.signal, submission.requestId)
        if (!result.ok) {
          if (!this.disposed && this.isCurrent(record.selected)) this.options.notice.set(result.error.message)
          this.fail(record, record.accepted)
          return
        }
        this.records.delete(record.id)
      } catch (error) {
        submission.abandon()
        throw error
      }
    } catch (error) {
      if (!this.disposed && this.isCurrent(record.selected)) {
        const prefix = record.accepted ? 'Prompt accepted; confirmation ended early' : 'Submission was not confirmed; no retry was sent'
        this.options.notice.set(`${prefix}: ${errorMessage(error)}`)
      }
      this.fail(record, record.accepted)
    }
  }

  private isCurrent(selected: EditorFeatureSession | undefined): boolean {
    const current = this.options.session()
    if (selected === undefined || current === undefined) return selected === current
    return current.client === selected.client
      && current.session === selected.session
      && current.ref.host === selected.ref.host
      && current.ref.sessionId === selected.ref.sessionId
      && current.generation === selected.generation
  }

  private fail(record: SubmissionRecord, accepted: boolean): void {
    this.records.delete(record.id)
    if (accepted) return
    record.rollback()
    if (this.disposed || !this.isCurrent(record.selected)
      || this.latest !== record || this.options.editor.getText().trim().length > 0) return
    if (record.historyText !== undefined) {
      this.options.editor.removeLatestHistory?.(record.historyText)
      this.stashHistory()
    }
    if (this.options.editor.restoreSubmittedDraft !== undefined) this.options.editor.restoreSubmittedDraft(record.submitted)
    else this.options.editor.setText(record.submitted.raw)
    this.stashDraft()
    this.options.screen.requestRender()
  }
}
