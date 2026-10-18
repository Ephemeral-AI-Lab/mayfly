/** The global launcher bin: a shebang and one argv hand-off to main.
 * @module @ephemeral-ai/mayfly-cli/tests/bin
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { main } = vi.hoisted(() => ({ main: vi.fn(async () => {}) }))
vi.mock('../src/main.ts', () => ({ main }))

const realArgv = process.argv

afterEach(() => {
  process.argv = realArgv
})

describe('bin entry', () => {
  it('hands process.argv.slice(2) to main exactly once', async () => {
    process.argv = ['/usr/bin/node', '/usr/local/bin/mayfly', '--version', '--profile', 'mayfly']
    await import('../src/bin.ts')
    expect(main).toHaveBeenCalledTimes(1)
    expect(main).toHaveBeenCalledWith(['--version', '--profile', 'mayfly'])
  })
})
