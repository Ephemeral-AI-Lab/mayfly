/** Pure mention-token parsing shared by completion and editor triggers.
 * @module @ephemeral-ai/mayfly/internal/mention
 */

export function extractMentionToken(text: string): string | null {
  return /(?:^|[\s"'=])(@(?:"[^"]*"?|'[^']*'?|[^\s"'=]*))$/u.exec(text)?.[1] ?? null
}

export function mentionPath(token: string): string {
  const path = token.slice(1)
  const quote = path.charAt(0)
  if (quote !== '"' && quote !== "'") return path
  return path.endsWith(quote) && path.length > 1 ? path.slice(1, -1) : path.slice(1)
}

/** pi-tui's fd query resolver does not preserve these native path forms. */
export function requiresFilesystemMention(token: string, platform: NodeJS.Platform = process.platform): boolean {
  if (token.startsWith("@'") || token.endsWith('"')) return true
  const path = mentionPath(token)
  return platform === 'win32' ? /^[a-z]:[\\/]/iu.test(path) : path.includes('\\')
}
