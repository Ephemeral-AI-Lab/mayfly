/**
 * Pure command, feedback, fuzzy-match, and draft helpers for the Remote editor.
 * @module @ephemeral-ai/mayfly/remote/editor/utils
 */

import type { MayflyComponents, MayflySubmittedDraft } from '@ephemeral-ai/mayfly/core'
import type { EditorCommandDescriptor, EditorParsedCommand } from './types.ts'

/** Convert an unknown operation failure to bounded single-line editor feedback. */
export function errorMessage(error: unknown, fallback = 'operation failed'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  return (message.trim() || fallback).replace(/\s*[\r\n]+\s*/gu, ' · ').slice(0, 2_000)
}

/** Parse a strict leading slash command while preserving the argument suffix verbatim. */
export function parseEditorCommand(line: string): EditorParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9-]*)([\s\S]*)$/u.exec(line)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const rawInput = match[2]
  if (rawInput.length > 0 && !/^\s/u.test(rawInput)) return undefined
  return { name: match[1], rawInput }
}

/** Resolve a typed command to its local canonical descriptor without changing Host semantics. */
export function canonicalLocalCommand(
  commands: readonly EditorCommandDescriptor[],
  name: string,
): EditorCommandDescriptor | undefined {
  return commands.find(command => command.name === name || command.aliases?.includes(name) === true)
}

/** Rebuild a canonical local command line, preserving every argument character. */
export function canonicalCommandLine(command: EditorCommandDescriptor, rawInput: string): string {
  return `/${command.name}${rawInput}`
}

/** One fuzzy match and whether an alias produced it. */
export interface EditorCommandMatch<T extends EditorCommandDescriptor> {
  readonly command: T
  readonly viaAlias: boolean
}

function scoreTokens(tokens: readonly string[], text: string, components: MayflyComponents): number | null {
  let score = 0
  for (const token of tokens) {
    const match = components.fuzzyMatch(token, text)
    if (!match.matches) return null
    score += match.score
  }
  return score
}

/** Rank canonical names first and use aliases only when the canonical name misses. */
export function filterEditorCommands<T extends EditorCommandDescriptor>(
  commands: readonly T[],
  query: string,
  components: MayflyComponents,
): EditorCommandMatch<T>[] {
  const tokens = query.split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return commands.map(command => ({ command, viaAlias: false }))
  return commands.flatMap((command): Array<EditorCommandMatch<T> & { score: number }> => {
    const canonical = scoreTokens(tokens, command.name, components)
    if (canonical !== null) return [{ command, viaAlias: false, score: canonical }]
    let best: number | undefined
    for (const alias of command.aliases ?? []) {
      const score = scoreTokens(tokens, alias, components)
      if (score !== null && (best === undefined || score < best)) best = score
    }
    return best === undefined ? [] : [{ command, viaAlias: true, score: best }]
  }).sort((left, right) => left.score - right.score || Number(left.viaAlias) - Number(right.viaAlias))
    .map(({ command, viaAlias }) => ({ command, viaAlias }))
}

/** Display an alias match with the aliases that explain its presence. */
export function editorCommandLabel(match: EditorCommandMatch<EditorCommandDescriptor>): string {
  return match.viaAlias
    ? `/${match.command.name} (${(match.command.aliases ?? []).join(', ')})`
    : `/${match.command.name}`
}

/** Frontend-local draft, shell mode, history, and paste tables surviving editor rebuilds. */
export class EditorDraftStore {
  private draft: MayflySubmittedDraft = { raw: '', pastes: new Map() }
  private mode: 'prompt' | 'bash' = 'prompt'
  private history: readonly string[] = []
  private historyPastes: readonly (ReadonlyMap<number, string> | undefined)[] = []

  stashDraft(draft: MayflySubmittedDraft): void { this.draft = draft }
  clearDraft(): void {
    this.draft = { raw: '', pastes: new Map() }
    this.mode = 'prompt'
  }
  currentDraft(): MayflySubmittedDraft { return this.draft }
  stashMode(mode: 'prompt' | 'bash'): void { this.mode = mode }
  currentMode(): 'prompt' | 'bash' { return this.mode }
  stashHistory(entries: readonly string[], pastes: readonly (ReadonlyMap<number, string> | undefined)[]): void {
    this.history = [...entries]
    this.historyPastes = [...pastes]
  }
  currentHistory(): readonly string[] { return this.history }
  currentHistoryPastes(): readonly (ReadonlyMap<number, string> | undefined)[] { return this.historyPastes }
}
