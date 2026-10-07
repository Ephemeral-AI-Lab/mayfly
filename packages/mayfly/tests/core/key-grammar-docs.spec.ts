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

  it('documents the F6 order, views first and then the interactive panes, in both languages and in the shared table', async () => {
    const row = SHARED_KEY_REFERENCE.find(candidate => candidate.keys.includes('F6'))!
    expect(row.action).toContain('F6 enters them first, then the interactive panes')
    expect(row.keys).toContain('Alt+↓')
    for (const [path, views, panes] of [['en/reference/keys.md', 'the views of the status bar', 'then the interactive panes'], ['reference/keys.md', '状态栏视图', '再按布局顺序进入可交互的 pane']] as const) {
      const f6 = (await readFile(resolve(website, path), 'utf8')).split('\n').find(line => line.startsWith('| `F6`'))!
      expect(f6, path).toContain(views)
      expect(f6, path).toContain(panes)
    }
  })
})
