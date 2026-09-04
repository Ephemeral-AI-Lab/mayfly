/**
 * Architecture guard keeping terminal key encodings in core/keymap.
 * @module keyboard-boundary
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const audited = [resolve(root, 'src/interaction'), resolve(root, 'src/transcript')]
const rawOutputSanitizers = new Set([
  resolve(root, 'src/interaction/shell-sanitize.ts'),
  resolve(root, 'src/interaction/updater/io.ts'),
])

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

describe('keyboard ownership boundary', () => {
  it('keeps raw escape-key encodings out of interaction and transcript code', async () => {
    for (const directory of audited) {
      for (const path of await sourceFiles(directory)) {
        if (rawOutputSanitizers.has(path)) continue
        const source = await readFile(path, 'utf8')
        expect(source, path).not.toContain('\\x1b')
        expect(source, path).not.toContain("handleInput?.('\\r')")
      }
    }
  })
})
