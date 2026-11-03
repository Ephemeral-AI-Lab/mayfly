/**
 * Architecture guard for `src/components/`: components are pure functions of facts that return `ui.*` nodes, so they
 * import only the UI contract and their siblings and know nothing of widths, ANSI, clocks, keys, or the runtime.
 * @module components-layering
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const area = resolve(root, 'src/components')

/** The only package a component may import besides its siblings. */
const ALLOWED_PACKAGE = '@ephemeral-ai/mayfly-ui'

/** Source with comments removed and string and template contents blanked, so a rule reads code and not prose. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' '))
    .replace(/\/\/[^\n]*/gu, '')
}

/** The module specifiers a source imports or re-exports, whether static or dynamic. */
function specifiers(code: string): string[] {
  return [
    ...code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/gu),
    ...code.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/gu),
    ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map(match => match[1]!)
}

/**
 * The rules a component source breaks.
 * @param source - the file's text.
 * @returns one message per broken rule, empty when the file is clean.
 */
function violations(source: string): string[] {
  const code = codeOf(source)
  const found: string[] = []
  for (const specifier of specifiers(code)) {
    if (specifier === ALLOWED_PACKAGE) continue
    if (/^\.\/[^/]+\.ts$/u.test(specifier)) continue
    found.push(`imports ${specifier}`)
  }
  const rules: [string, RegExp][] = [
    ['uses a width helper', /\b(?:visibleWidth|truncateToWidth|wrapText|wrapTextWithAnsi|sliceByColumn|stringWidth)\b/u],
    ['writes an escape sequence', /\\x1b|\\u001b|\\u\{1b\}|\\033|\\e\[/iu],
    ['starts a timer', /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\s*\(|\bDate\.now\s*\(|\bperformance\.now\s*\(/u],
    ['binds a key', /\bkeymap\b|\bkeyGrammar\b|\bmatchesKey\b|\bparseKey\b/iu],
  ]
  for (const [message, pattern] of rules) if (pattern.test(code)) found.push(message)
  return found
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

describe('components layering', () => {
  it('keeps every file under src/components pure of the runtime, widths, escapes, timers, and keys', async () => {
    const files = await sourceFiles(area)
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) expect(violations(await readFile(path, 'utf8')), path).toEqual([])
  })

  it('accepts the UI contract and sibling imports', () => {
    expect(violations([
      "import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'",
      "import { ui } from '@ephemeral-ai/mayfly-ui'",
      "import { rows } from './rows.ts'",
      "export { rows } from './rows.ts'",
    ].join('\n'))).toEqual([])
  })

  it('refuses a node module, Cordis, core, a parent path, or another package', () => {
    expect(violations("import { readFileSync } from 'node:fs'")).toEqual(['imports node:fs'])
    expect(violations("import { Context } from 'cordis'")).toEqual(['imports cordis'])
    expect(violations("import { width } from '../core/width.ts'")).toEqual(['imports ../core/width.ts'])
    expect(violations("import { x } from '../transcript/types.ts'")).toEqual(['imports ../transcript/types.ts'])
    expect(violations("export * from '@earendil-works/pi-tui'")).toEqual(['imports @earendil-works/pi-tui'])
    expect(violations("const core = await import('../core/screen.ts')")).toEqual(['imports ../core/screen.ts'])
    expect(violations("import './effects.ts'\nimport 'node:path'")).toEqual(['imports node:path'])
  })

  it('refuses a width helper, an escape sequence, a timer, and a key binding', () => {
    expect(violations('const w = visibleWidth(text)')).toEqual(['uses a width helper'])
    expect(violations('const cut = truncateToWidth(text, 8)')).toEqual(['uses a width helper'])
    expect(violations("const bold = '\\x1b[1m'")).toEqual(['writes an escape sequence'])
    expect(violations("const bold = '\\u001b[1m'")).toEqual(['writes an escape sequence'])
    expect(violations('setTimeout(() => {}, 10)')).toEqual(['starts a timer'])
    expect(violations('const now = Date.now()')).toEqual(['starts a timer'])
    expect(violations("keymap.bind('ctrl+o')")).toEqual(['binds a key'])
  })

  it('reads code, not comments', () => {
    expect(violations('// visibleWidth and setTimeout( are core concerns\n/* \\x1b and keymap */\nconst a = 1')).toEqual([])
  })
})
