/** Best-effort native temporary-directory cleanup never masks an accepted result.
 * @module @ephemeral-ai/mayfly/tests/interaction/io-cleanup
 */
import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withStagingDir } from '../../src/interaction/clipboard-probe.ts'
import { runExternalEditor, setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const retained: string[] = []
afterEach(async () => {
  setExternalEditorLauncher(undefined)
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  await Promise.all(retained.splice(0).map(path => actual.rm(path, { recursive: true, force: true })))
  vi.mocked(fs.rm).mockReset()
  vi.mocked(fs.rm).mockImplementation(actual.rm)
})

/** A real filesystem boundary can reject removal when an external process changes permissions. */
function refuseRemoval(): void {
  vi.mocked(fs.rm).mockImplementationOnce(async path => {
    retained.push(String(path))
    throw Object.assign(new Error('temporary directory is busy'), { code: 'EACCES' })
  })
}

describe('native I/O cleanup', () => {
  it('returns the clipboard probe result when staging cleanup is refused', async () => {
    refuseRemoval()
    await expect(withStagingDir(async path => {
      await fs.writeFile(`${path}/clipboard.txt`, 'clipboard bytes')
      return 'saved attachment'
    })).resolves.toBe('saved attachment')
    expect(retained).toHaveLength(1)
  })

  it('returns the editor read-back when its temporary directory cannot be removed', async () => {
    refuseRemoval()
    await expect(runExternalEditor('preserved draft', 'true')).resolves.toBe('preserved draft')
    expect(retained).toHaveLength(1)
  })
})
