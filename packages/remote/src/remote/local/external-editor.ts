/**
 * Remote-local draft editor with private temporary files and process teardown.
 * @module @ephemeral-ai/mayfly/remote/local/external-editor
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInheritedShell } from './process.ts'

/** Resolve configured command, then `$VISUAL`, then `$EDITOR`; blank values are ignored. */
export function resolveExternalEditorCommand(
  env: { VISUAL?: string | undefined, EDITOR?: string | undefined } = process.env,
  configured = '',
): string | undefined {
  if (configured.trim().length > 0) return configured.trim()
  for (const value of [env.VISUAL, env.EDITOR]) if (value !== undefined && value.trim().length > 0) return value.trim()
  return undefined
}

/** Quote a local temp path for the platform shell used by the configured editor command. */
export function quoteLocalShellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Edit local text once; a nonzero exit leaves the caller's draft untouched. */
export async function editLocalText(
  initialText: string,
  command: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'mayfly-remote-edit-'))
  const file = join(directory, 'prompt.md')
  await writeFile(file, initialText, 'utf8')
  try {
    const code = await runInheritedShell(`${command} ${quoteLocalShellArg(file)}`, signal)
    if (code !== 0 || signal.aborted) return undefined
    return await readFile(file, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
