/**
 * Selection-scoped Host command catalog and local-first command execution.
 * @module @ephemeral-ai/mayfly/remote/editor/commands
 */

import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from '../notice.ts'
import type {
  EditorCommandDescriptor,
  EditorFeatureSession,
  EditorLocalAdapter,
} from './types.ts'
import {
  canonicalCommandLine,
  canonicalLocalCommand,
  errorMessage,
  parseEditorCommand,
} from './utils.ts'

/** Encoded image accepted by this alpha's official commands.execute wire. */
export type EditorCommandAttachment = Extract<PromptContentPart, { readonly type: 'image' }>

interface CommandCatalogOptions {
  readonly session: () => EditorFeatureSession | undefined
  readonly local: EditorLocalAdapter
  readonly notice: RemoteNotice
  readonly t: MayflyTranslate
}

function selectionKey(selected: EditorFeatureSession | undefined): string {
  return selected === undefined ? '' : `${selected.ref.host}\0${selected.ref.sessionId}\0${String(selected.generation)}`
}

/** Owns one current command view and executes each command at most once. */
export class EditorCommands {
  private epoch = 0
  private key = ''
  private host: readonly EditorCommandDescriptor[] = []
  private flight: Promise<void> | undefined

  constructor(private readonly options: CommandCatalogOptions) {
    this.syncSelection()
  }

  /** Drop a retired selection's commands immediately and fence late list results. */
  syncSelection(): void {
    const key = selectionKey(this.options.session())
    if (key === this.key) return
    this.key = key
    this.epoch += 1
    this.host = []
    this.flight = undefined
  }

  /** Local commands shadow duplicate Host names in discovery, matching local-first routing. */
  list(): readonly EditorCommandDescriptor[] {
    this.syncSelection()
    const local = this.options.local.list()
    const names = new Set(local.map(command => command.name))
    return [...local, ...this.host.filter(command => !names.has(command.name))]
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  hint(name: string): string | undefined {
    return this.list().find(command => command.name === name)?.input?.hint
  }

  /** Refresh the exact selected Host catalog; stale completions cannot replace a newer selection. */
  refresh(): Promise<void> {
    this.syncSelection()
    if (this.flight !== undefined) return this.flight
    const selected = this.options.session()
    if (selected === undefined) return Promise.resolve()
    const ticket = ++this.epoch
    const key = this.key
    const promise = (async () => {
      try {
        const result = await selected.client.remote.commands.list(selected.ref.sessionId)
        if (ticket !== this.epoch || key !== this.key || !result.ok
          || this.options.session()?.client !== selected.client
          || selectionKey(this.options.session()) !== key) return
        this.host = result.value.map(command => ({
          name: command.name,
          description: command.description,
          ...command.input === undefined ? {} : { input: command.input },
        }))
      } catch {
        // Discovery remains local-only until the next explicit or forwarded refresh.
      }
    })()
    this.flight = promise
    void promise.finally(() => {
      if (this.flight === promise) this.flight = undefined
    })
    return promise
  }

  /** Route local commands first, then execute the original line against the exact Host Session. */
  async execute(
    line: string,
    attachments: readonly EditorCommandAttachment[],
    signal: AbortSignal,
  ): Promise<{ readonly handled: boolean, readonly exit: boolean, readonly accepted: boolean }> {
    this.syncSelection()
    const parsed = parseEditorCommand(line)
    if (parsed === undefined) {
      this.options.notice.set(this.options.t('unknown command: {command}', { command: line }))
      return { handled: true, exit: false, accepted: false }
    }
    const selected = this.options.session()
    const isCurrent = (): boolean => {
      const current = this.options.session()
      if (signal.aborted) return false
      if (selected === undefined || current === undefined) return selected === current
      return current.client === selected.client && selectionKey(current) === selectionKey(selected)
    }
    const local = canonicalLocalCommand(this.options.local.list(), parsed.name)
    if (local !== undefined) {
      const canonical = canonicalCommandLine(local, parsed.rawInput)
      const result = await this.options.local.execute({
        line: canonical,
        name: local.name,
        rawInput: parsed.rawInput,
        attachments,
        session: selected,
        signal,
      })
      if (result.kind !== 'unhandled') {
        if (isCurrent() && result.text !== undefined) this.options.notice.set(result.text)
        return {
          handled: true,
          exit: isCurrent() && result.kind === 'success' && result.exit === true,
          accepted: result.kind === 'success',
        }
      }
    }
    if (selected === undefined) {
      this.options.notice.set(this.options.t('Send a message first: /{command} needs a session', { command: parsed.name }))
      return { handled: true, exit: false, accepted: false }
    }
    if (selected.access === 'readonly') {
      this.options.notice.set(this.options.t('This conversation is read-only'))
      return { handled: true, exit: false, accepted: false }
    }
    const result = await selected.client.remote.commands.execute(selected.ref.sessionId, line, attachments, signal)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value === undefined) {
      if (isCurrent()) this.options.notice.set(this.options.t('unknown command: {command}', { command: line }))
      return { handled: true, exit: false, accepted: false }
    }
    const outcome = result.value.result
    if (isCurrent() && outcome.text !== undefined) this.options.notice.set(outcome.text)
    return { handled: true, exit: false, accepted: outcome.kind === 'success' }
  }

  /** Convert a thrown local or transport failure for the submit owner. */
  failure(error: unknown): string {
    return errorMessage(error, this.options.t('command execution failed'))
  }
}
