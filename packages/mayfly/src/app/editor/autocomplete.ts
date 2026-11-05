/**
 * Fuzzy slash, Host file mention, and skill autocomplete with generation fencing.
 * @module @ephemeral-ai/mayfly/remote/editor/autocomplete
 */

import type { MayflyAutocompleteItem, MayflyAutocompleteProvider, MayflyAutocompleteSuggestions, MayflyComponents } from '../../core/types.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from '../notice.ts'
import type { EditorCommands } from './commands.ts'
import type { EditorSkills } from './skills.ts'
import type { EditorFeatureSession, EditorTokenSpan } from './types.ts'
import { activeMention, applyMention, mentionItem } from './mentions.ts'
import { editorCommandLabel, filterEditorCommands, parseEditorCommand } from './utils.ts'
import { extractSkillPrefix } from './skills.ts'

const MENTION = /(?<=^|[\s"'=])@(?:"[^"]*"|'[^']*'|[^\s"'=]+)(?=\s|$)/gu

interface AutocompleteOptions {
  readonly session: () => EditorFeatureSession | undefined
  readonly commands: EditorCommands
  readonly skills: EditorSkills
  readonly components: MayflyComponents
  readonly notice: RemoteNotice
  readonly t: MayflyTranslate
  readonly bash: () => boolean
  readonly beginWait: (message: string, signal: AbortSignal) => () => void
}

function replaceLine(lines: string[], index: number, line: string): string[] {
  return lines.map((source, at) => at === index ? line : source)
}

/** One editor-lifetime autocomplete owner. Every new query retires the previous query. */
export class EditorAutocomplete {
  private readonly provider: MayflyAutocompleteProvider
  private readonly acceptedMentions = new Set<string>()
  private lifetime = new AbortController()
  private revision = 0
  private disposed = false

  constructor(private readonly options: AutocompleteOptions) {
    this.provider = {
      triggerCharacters: ['/', '@', '#'],
      getSuggestions: (lines, cursorLine, cursorCol, request) => this.suggest(lines, cursorLine, cursorCol, request.signal),
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => this.apply(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => activeMention(lines[cursorLine] ?? '', cursorCol) !== undefined,
    }
  }

  source(): MayflyAutocompleteProvider { return this.provider }

  /** Abort Host reads on edit, selection, Host revision, and detach. */
  invalidate(): void {
    this.revision += 1
    this.lifetime.abort()
    this.lifetime = new AbortController()
  }

  /** Accepted mentions are tokens without synchronous local Host-path existence probes. */
  tokenSpans(line: string): readonly EditorTokenSpan[] {
    if (!line.includes('@')) return []
    const spans: EditorTokenSpan[] = []
    for (const match of line.matchAll(MENTION)) {
      if (this.acceptedMentions.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length, kind: 'mention' })
    }
    return spans
  }

  /** Finish a directory as a mention after the foundation's Enter-on-folder behavior. */
  acceptDirectory(value: string): void {
    this.acceptedMentions.add(value)
  }

  /** Argument ghost for one completed slash token, including local aliases. */
  ghost(text: string): string | undefined {
    if (this.options.bash()) return undefined
    const match = /^\/(\S+)( ?)$/u.exec(text)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    const typed = match[1]
    const command = this.options.commands.list().find(candidate => candidate.name === typed || candidate.aliases?.includes(typed) === true)
    const hint = command?.input?.hint
    if (hint === undefined || hint.length === 0) return undefined
    return match[2] === ' ' ? hint : ` ${hint}`
  }

  /** Explain an unmatched strict slash line in the editor hint. */
  slashHint(text: string): string | undefined {
    if (!text.startsWith('/')) return undefined
    const parsed = parseEditorCommand(text)
    if (parsed === undefined && text !== '/') return undefined
    const query = parsed?.name ?? ''
    if (filterEditorCommands(this.options.commands.list(), query, this.options.components).length > 0) return undefined
    return this.options.t('no matching command: /{command}', { command: query })
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    this.acceptedMentions.clear()
  }

  private async suggest(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    requestSignal: AbortSignal,
  ): Promise<MayflyAutocompleteSuggestions | null> {
    if (this.disposed) return null
    this.invalidate()
    const ticket = this.revision
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal])
    const line = lines[cursorLine] ?? ''
    const mention = activeMention(line, cursorCol)
    if (mention !== undefined) {
      const selected = this.options.session()
      if (selected === undefined) return null
      const endWait = this.options.beginWait(this.options.t('Searching files…'), signal)
      try {
        const result = await selected.client.remote.fileReferences.list(selected.ref.sessionId, mention.query, signal)
        if (this.disposed || ticket !== this.revision || signal.aborted || !result.ok) return null
        const current = this.options.session()
        if (current?.client !== selected.client
          || current.ref.host !== selected.ref.host
          || current.ref.sessionId !== selected.ref.sessionId
          || current.generation !== selected.generation) return null
        const items = result.value.flatMap((candidate): MayflyAutocompleteItem[] => {
          const item = mentionItem(candidate, mention.quoted)
          return item === undefined ? [] : [item]
        })
        if (items.length === 0) {
          this.options.notice.set(this.options.t('no matching files under the session cwd'))
          return null
        }
        return { items, prefix: mention.prefix }
      } catch {
        return null
      } finally {
        endWait()
      }
    }
    const skillQuery = extractSkillPrefix(line.slice(0, cursorCol))
    if (skillQuery !== null) {
      if (this.options.bash()) return null
      const skills = this.options.skills.list()
      if (skills.length === 0) {
        void this.options.skills.refresh()
        return null
      }
      const items = filterEditorCommands(
        skills.map(skill => ({ name: skill.name, description: skill.description, skill })),
        skillQuery,
        this.options.components,
      ).map((match): MayflyAutocompleteItem => ({
        value: `#${match.command.name}`,
        label: `#${match.command.name}`,
        description: match.command.skill.modelInvocable
          ? match.command.skill.description
          : `user-only · ${match.command.skill.description}`,
      }))
      return items.length === 0 ? null : { items, prefix: `#${skillQuery}` }
    }
    const slash = /^\/(\S*)$/u.exec(line.slice(0, cursorCol))
    if (slash === null || this.options.bash()) return null
    const query = slash[1]!
    const items = filterEditorCommands(this.options.commands.list(), query, this.options.components)
      .map((match): MayflyAutocompleteItem => ({
        value: `/${match.command.name}`,
        label: editorCommandLabel(match),
        description: match.command.input?.hint === undefined
          ? match.command.description
          : `${match.command.input.hint} — ${match.command.description}`,
      }))
    return { items, prefix: `/${query}` }
  }

  private apply(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: MayflyAutocompleteItem,
    prefix: string,
  ): { lines: string[], cursorLine: number, cursorCol: number } {
    const line = lines[cursorLine] ?? ''
    if (prefix.startsWith('@') && activeMention(line, cursorCol) !== undefined) {
      const applied = applyMention(lines, cursorLine, cursorCol, item, prefix)
      if (!item.label.endsWith('/')) this.acceptedMentions.add(item.value)
      return applied
    }
    if (prefix.startsWith('#') && extractSkillPrefix(line.slice(0, cursorCol)) !== null) {
      const head = `${line.slice(0, Math.max(0, cursorCol - prefix.length))}${item.value} `
      return {
        lines: replaceLine(lines, cursorLine, head + line.slice(cursorCol).trimStart()),
        cursorLine,
        cursorCol: head.length,
      }
    }
    if (line.startsWith('/')) {
      const head = `${item.value} `
      return {
        lines: replaceLine(lines, cursorLine, head + line.slice(cursorCol).trimStart()),
        cursorLine,
        cursorCol: head.length,
      }
    }
    return { lines: [...lines], cursorLine, cursorCol }
  }
}
