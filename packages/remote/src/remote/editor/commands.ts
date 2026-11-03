/**
 * Selection-scoped Host command catalog and local-first command execution.
 * @module @ephemeral-ai/mayfly/remote/editor/commands
 */

import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
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

/** Ordered encoded images and uploaded file receipts accepted by the native command wire. */
export type EditorCommandAttachment = CommandSubmitAttachment

interface CommandCatalogOptions {
  readonly session: () => EditorFeatureSession | undefined
  readonly local: EditorLocalAdapter
  readonly notice: RemoteNotice
  readonly t: MayflyTranslate
}

function selectionKey(selected: EditorFeatureSession | undefined): string {
  return selected === undefined ? '' : `${selected.ref.host}\0${selected.ref.sessionId}\0${String(selected.generation)}\0${selected.access ?? 'interactive'}`
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
    const names = new Set(local.flatMap(command => [command.name, ...command.aliases ?? []]))
    return [...local, ...this.host.filter(command => !names.has(command.name)
      && this.options.local.resolve?.(command.name)?.hidden !== true)]
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
    if (selected === undefined || selected.access === 'readonly') return Promise.resolve()
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
    onRefused: () => void = () => {},
  ): Promise<{ readonly handled: boolean, readonly exit: boolean, readonly accepted: boolean }> {
    this.syncSelection()
    if (signal.aborted) return { handled: true, exit: false, accepted: false }
    const parsed = parseEditorCommand(line)
    if (parsed === undefined) {
      onRefused()
      this.options.notice.set(this.options.t('unknown command: {command}', { command: line }), 'error')
      return { handled: true, exit: false, accepted: false }
    }
    const selected = this.options.session()
    const isCurrent = (): boolean => {
      const current = this.options.session()
      if (signal.aborted) return false
      if (selected === undefined || current === undefined) return selected === current
      return current.client === selected.client && current.session === selected.session && selectionKey(current) === selectionKey(selected)
    }
    const local = canonicalLocalCommand(this.options.local.list(), parsed.name) ?? this.options.local.resolve?.(parsed.name)
    if (local !== undefined) {
      const canonical = canonicalCommandLine(local, parsed.rawInput)
      let result
      try {
        result = await this.options.local.execute({
          line: canonical,
          name: local.name,
          rawInput: parsed.rawInput,
          attachments,
          session: selected,
          signal,
        })
      } catch (error) {
        if (!isCurrent()) return { handled: true, exit: false, accepted: false }
        this.options.notice.set(this.failure(error), 'error')
        return { handled: true, exit: false, accepted: true }
      }
      if (result.kind !== 'unhandled') {
        if (isCurrent() && result.text !== undefined) {
          if (result.kind === 'error') onRefused()
          this.options.notice.set(result.text, result.kind === 'error' ? 'error' : 'info')
        }
        return {
          handled: true,
          exit: isCurrent() && result.kind === 'success' && result.exit === true,
          accepted: result.kind === 'success',
        }
      }
    }
    if (!isCurrent()) return { handled: true, exit: false, accepted: false }
    if (selected === undefined) {
      onRefused()
      this.options.notice.set(this.options.t('Send a message first: /{command} needs a session', { command: parsed.name }), 'error')
      return { handled: true, exit: false, accepted: false }
    }
    if (selected.access === 'readonly') {
      onRefused()
      this.options.notice.set(this.options.t('This conversation is read-only'), 'error')
      return { handled: true, exit: false, accepted: false }
    }
    const result = await selected.client.remote.commands.execute(selected.ref.sessionId, line, attachments, signal)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value === undefined) {
      if (isCurrent()) {
        onRefused()
        this.options.notice.set(this.options.t('unknown command: {command}', { command: line }), 'error')
      }
      return { handled: true, exit: false, accepted: false }
    }
    const outcome = result.value.result
    if (isCurrent() && outcome.text !== undefined && (parsed.name !== 'goal' || outcome.kind === 'error')) this.options.notice.set(outcome.text, outcome.kind === 'error' ? 'error' : 'info')
    return { handled: true, exit: false, accepted: true }
  }

  /** Convert a thrown local or transport failure for the submit owner. */
  failure(error: unknown): string {
    return errorMessage(error, this.options.t('command execution failed'))
  }
}
