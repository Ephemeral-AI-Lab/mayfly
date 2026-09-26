/** The Website key reference and /help describe the same shared panel grammar.
 * @module @ephemeral-ai/mayfly/tests/core/key-grammar-docs
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARED_KEY_REFERENCE } from '../../src/core/ui-key-grammar.ts'
import { INTERACTION_LOCALE } from '../../src/interaction/locale.ts'

const website = resolve(import.meta.dirname, '../../../../website')

async function sharedKeyRows(path: string): Promise<readonly string[]> {
  const page = await readFile(resolve(website, path), 'utf8')
  const start = page.indexOf('<!-- BEGIN shared-keys')
  const end = page.indexOf('<!-- END shared-keys -->')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return page.slice(start, end).split('\n').filter(line => line.startsWith('| `'))
}

describe('shared panel key reference', () => {
  it('matches the English Website table row for row', async () => {
    expect(await sharedKeyRows('en/reference/keys.md')).toEqual(SHARED_KEY_REFERENCE.map(row => `| \`${row.keys}\` | ${row.action} |`))
  })

  it('matches the Chinese Website table through the interaction catalog', async () => {
    const zh = INTERACTION_LOCALE.zh
    for (const row of SHARED_KEY_REFERENCE) expect(zh[row.action], row.action).toBeDefined()
    expect(await sharedKeyRows('reference/keys.md')).toEqual(SHARED_KEY_REFERENCE.map(row => `| \`${zh[row.keys] ?? row.keys}\` | ${zh[row.action]!} |`))
  })
})
