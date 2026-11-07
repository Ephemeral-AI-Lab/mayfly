/** Publication invariants of the TUI package: its public surface and its Host boundary. @module script/tui-publication */

/** The TUI's only public entry points. */
export const TUI_EXPORTS = Object.freeze(['.', './client', './bin', './package.json'])
/** Host subpaths that compile into the client; every other Host entry is Host-process runtime. */
export const HOST_CLIENT_SUBPATHS = Object.freeze(['/remote', '/types', '/conversation'])

const HOST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]@ephemeral-ai\/mayfly-host((?:\/[^'"]*)?)['"]/gu

/** Reject a widened public surface, any composition payload, and Host-process imports in the TUI's runtime. */
export function tuiPackageProblems(manifest, files = []) {
  const problems = []
  const entries = Object.keys(manifest.exports ?? {})
  if (entries.join('\n') !== TUI_EXPORTS.join('\n')) problems.push(`exports must be exactly ${TUI_EXPORTS.join(', ')}; found ${entries.join(', ')}`)
  if (manifest.dsh !== undefined) problems.push('the TUI must not declare a dsh bundle')
  for (const path of [...manifest.files ?? [], ...files.map(file => file.path)]) {
    if (/(?:^|\/)presets(?:\/|$)|\.patch\.yml$/u.test(path)) problems.push(`composition payload ${path} must not be published`)
  }
  for (const file of files) {
    if (!file.path.startsWith('lib/') || !file.path.endsWith('.js') || typeof file.content !== 'string') continue
    for (const match of file.content.matchAll(HOST_IMPORT)) {
      if (!HOST_CLIENT_SUBPATHS.includes(match[1])) problems.push(`${file.path} imports Host-process entry @ephemeral-ai/mayfly-host${match[1]}`)
    }
  }
  return problems
}
