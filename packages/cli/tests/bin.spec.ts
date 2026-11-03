/** The global launcher bin preserves its shebang hand-off to the Remote bin. */
import { describe, expect, it, vi } from 'vitest'

const { run } = vi.hoisted(() => ({ run: vi.fn(async () => {}) }))
vi.mock('@ephemeral-ai/mayfly-remote/remote-bin', () => ({ run }))

describe('bin entry', () => {
  it('runs the independent Remote bin exactly once', async () => {
    await import('../src/bin.ts')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith()
  })
})
