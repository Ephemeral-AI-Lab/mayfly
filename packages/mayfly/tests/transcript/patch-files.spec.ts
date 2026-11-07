/** The files of a patch, read from its text, whole or as far as it has streamed. @module @ephemeral-ai/mayfly/tests/transcript/patch-files */
import { describe, expect, it } from 'vitest'
import { patchFiles } from '../../src/transcript/patch-files.ts'

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/reorder.ts',
  '+export function move() {',
  '+}',
  '*** Delete File: src/legacy.ts',
  '*** Update File: src/menu-old.ts',
  '*** Move to: src/menu.ts',
  '@@ top',
  ' keep',
  "-import './menu-old.css'",
  "+import './menu.css'",
  '@@',
  '-a',
  '+b',
  '*** Update File: src/list.ts',
  '-one',
  '+two',
  '*** End of File',
  '*** End Patch',
].join('\n')

describe('the files of a patch', () => {
  it('names every file with what happens to it, its counts and its hunks', () => {
    expect(patchFiles(PATCH)).toEqual([
      { kind: 'A', path: 'src/reorder.ts', added: 2, removed: 0, hiddenLines: 0, hunks: [{ before: '', after: 'export function move() {\n}' }] },
      { kind: 'D', path: 'src/legacy.ts', added: 0, removed: 0, hiddenLines: 0, hunks: [] },
      { kind: 'R', path: 'src/menu.ts', from: 'src/menu-old.ts', added: 2, removed: 2, hiddenLines: 0, hunks: [
        { before: "keep\nimport './menu-old.css'", after: "keep\nimport './menu.css'" },
        { before: 'a', after: 'b' },
      ] },
      { kind: 'M', path: 'src/list.ts', added: 1, removed: 1, hiddenLines: 0, hunks: [{ before: 'one', after: 'two' }] },
    ])
  })

  it('reads a patch as far as it has streamed, and has nothing before its first file', () => {
    expect(patchFiles('*** Begin Patch\n+stray\n*** Move to: nowhere')).toEqual([])
    expect(patchFiles('*** Begin Patch\n*** Update File: src/li')).toMatchObject([{ kind: 'M', path: 'src/li', hunks: [] }])
    expect(patchFiles('')).toEqual([])
  })

  it('keeps a blank line inside a hunk as context, and none between a header and its hunk', () => {
    expect(patchFiles('*** Update File: a\n\n@@\n x\n\n-y').at(0)?.hunks).toEqual([{ before: '\ny', after: '' }])
  })

  it('counts a long hunk whole and cuts what it carries', () => {
    const long = Array.from({ length: 70 }, (_, index) => `+${String(index)}`).join('\n')
    const [file] = patchFiles(`*** Add File: big\n${long}`)
    expect(file).toMatchObject({ added: 70, hiddenLines: 10 })
    expect(file!.hunks[0]!.after.split('\n')).toHaveLength(60)
  })
})
