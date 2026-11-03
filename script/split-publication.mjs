/** Split-only shared renderer publication invariants. @module script/split-publication */

const RETIRED_ENTRIES = new Set([
  '.', './startup', './app', './interaction', './status-jobs', './status-goal',
  './pane-activity', './pane-todo', './btw-command', './status-agents', './jobs',
  './agents-command', './mode-status', './attachments', './paste-image', './cordis.patch.yml',
])
const SHARED_HARNESS_RUNTIME = new Set([
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session/surface',
])

/** Reject legacy native composition and any Host service import in the renderer package. */
export function sharedRendererProblems(manifest, files = []) {
  const problems = []
  if (manifest.main !== undefined || manifest.types !== undefined) problems.push('shared renderer must expose only explicit subpaths')
  if (manifest.dsh !== undefined) problems.push('shared renderer must not declare a dsh bundle')
  for (const entry of Object.keys(manifest.exports ?? {})) {
    if (RETIRED_ENTRIES.has(entry)) problems.push(`retired native entry ${entry} must not be published`)
  }
  for (const path of manifest.files ?? []) {
    if (/(?:^|\/)presets(?:\/|$)|\.patch\.yml$/u.test(path)) problems.push(`legacy composition payload ${path} must not be published`)
  }
  for (const file of files) {
    if (/(?:^|\/)presets(?:\/|$)|\.patch\.yml$/u.test(file.path)) problems.push(`legacy packed payload ${file.path}`)
    if (!file.path.startsWith('lib/') || !file.path.endsWith('.js') || typeof file.content !== 'string') continue
    for (const match of file.content.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)['"](@deepseek-ai\/[^'"]+|@ephemeral-ai\/mayfly-host(?:\/[^'"]*)?)['"]/gu)) {
      if (!SHARED_HARNESS_RUNTIME.has(match[1])) problems.push(`${file.path} imports Host runtime ${match[1]}`)
    }
  }
  return problems
}
