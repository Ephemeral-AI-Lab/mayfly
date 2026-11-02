/** Same-facts browser nodes byte-for-byte from the immutable rc.2 command source. @module */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FilesBrowser, filesBrowserItems, filesBrowserRow, filesRowId, type FilesBrowserFacts } from '../../src/interaction/files-browser-model.ts'
import { FilesBrowser as publicBrowser } from '../../src/files-browser.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/files-browser-rc2.json', import.meta.url), 'utf8')) as {
  readonly provenance: { readonly sha: string }
  readonly scenarios: readonly { readonly name: string, readonly facts: FilesBrowserFacts, readonly node: unknown }[]
}

describe('frozen Files browser wire parity', () => {
  it('keeps the public entry as the real native and Remote builder', () => {
    expect(publicBrowser).toBe(FilesBrowser)
    expect(fixture.provenance.sha).toBe('f148e7045cc22a66e62c0cd5203f8eeca1368081')
  })
  for (const scenario of fixture.scenarios) it(scenario.name, () => {
    expect(JSON.parse(JSON.stringify(FilesBrowser(scenario.facts, key => key)))).toEqual(scenario.node)
    for (const item of filesBrowserItems(scenario.facts)) {
      expect(filesRowId(filesBrowserRow(scenario.facts, item.id)!)).toBe(item.id)
    }
  })
  it('does not resolve an unknown row without a native changes summary', () => {
    expect(filesBrowserRow({ files: [], detailMode: false, canOpen: false }, 'absent')).toBeUndefined()
  })
})
