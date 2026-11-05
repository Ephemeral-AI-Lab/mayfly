/**
 * Official-compatible file mention grammar, formatting, and Host file reads.
 * @module @ephemeral-ai/mayfly/remote/editor/mentions
 */

import type { FileReferenceCandidate } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyAutocompleteItem } from '../../core/types.ts'
import type { EditorFeatureSession, EditorHostFiles, EditorHostFileSnapshot } from './types.ts'

/** Active `@` token at the editor cursor. */
interface ActiveMention {
  readonly prefix: string
  readonly query: string
  readonly quoted: boolean
}

/** Extract the active `@path` or `@"path"` token without treating email text as a trigger. */
export function activeMention(line: string, cursorCol: number): ActiveMention | undefined {
  const before = line.slice(0, cursorCol)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(before)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true }
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(before)
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined
  return { prefix: plain[1], query: plain[2], quoted: false }
}

/** Format a Host candidate with the official quoted-path and open-directory grammar. */
export function formatMention(candidate: FileReferenceCandidate, preserveQuote: boolean): string | undefined {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  return candidate.kind === 'directory' ? `@"${path}` : `@"${path}"`
}

/** Shape one Host candidate as a completion item. */
export function mentionItem(candidate: FileReferenceCandidate, preserveQuote: boolean): MayflyAutocompleteItem | undefined {
  const formatted = formatMention(candidate, preserveQuote)
  if (formatted === undefined) return undefined
  const value = candidate.kind === 'directory' && formatted.startsWith('@"') && !formatted.endsWith('"')
    ? `${formatted}"`
    : formatted
  return { value, label: candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path }
}

/** Extract the Host path from an accepted mention; it is never a local filesystem assertion. */
export function mentionPath(token: string): string {
  const path = token.slice(1)
  const quote = path.charAt(0)
  if (quote !== '"' && quote !== "'") return path
  return path.endsWith(quote) && path.length > 1 ? path.slice(1, -1) : path.slice(1)
}

/** Apply a file or directory completion while preserving quoted directory drill-down. */
export function applyMention(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: MayflyAutocompleteItem,
  prefix: string,
): { lines: string[], cursorLine: number, cursorCol: number } {
  const line = lines[cursorLine] ?? ''
  const before = line.slice(0, Math.max(0, cursorCol - prefix.length))
  const after = line.slice(cursorCol)
  const trailingQuote = prefix.startsWith('@"') && item.value.endsWith('"') && after.startsWith('"')
    ? after.slice(1)
    : after
  const directory = item.label.endsWith('/')
  const suffix = directory ? '' : ' '
  const valueOffset = directory && item.value.endsWith('"') ? item.value.length - 1 : item.value.length
  return {
    lines: lines.map((source, index) => index === cursorLine ? `${before}${item.value}${suffix}${trailingQuote}` : source),
    cursorLine,
    cursorCol: before.length + valueOffset + suffix.length,
  }
}

/** Read a Host text file through the official workspaceFiles methods. */
export async function readHostFile(
  selected: EditorFeatureSession,
  files: EditorHostFiles,
  path: string,
  signal: AbortSignal,
): Promise<EditorHostFileSnapshot> {
  const stat = await files.stat(selected.ref.sessionId, path, signal)
  if (!stat.ok) throw new Error(stat.error.message)
  const data = await files.readBytes(selected.ref.sessionId, path, signal)
  if (!data.ok) throw new Error(data.error.message)
  return {
    absolutePath: data.value.absolutePath,
    version: data.value.version,
    text: new TextDecoder('utf-8', { fatal: true }).decode(data.value.data),
  }
}
