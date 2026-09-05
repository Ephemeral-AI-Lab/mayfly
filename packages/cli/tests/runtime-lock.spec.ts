/** Cross-process publication lock ownership, waiting, and stale recovery. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, utimesSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { describe, expect, it, vi } from 'vitest'
import { cliInternals } from '../src/internals.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

registerTempDirCleanup()
vi.mock('proper-lockfile', async importOriginal => {
  const actual = await importOriginal<typeof import('proper-lockfile')>()
  return { ...actual, lock: vi.fn(actual.lock) }
})

describe('runtime publication locks', () => {
  it('waits for the current publisher and releases after the synchronous section', async () => {
    const target = join(mkdtempTracked('mayfly-runtime-lock-'), 'cache')
    const release = await lock(target, { realpath: false })
    let ran = false
    const pending = cliInternals.withRuntimeLock(target, assertLock => {
      assertLock()
      expect(existsSync(`${target}.lock`)).toBe(true)
      ran = true
      return 'published'
    })
    expect(ran).toBe(false)
    await release()
    await expect(pending).resolves.toBe('published')
    expect(existsSync(`${target}.lock`)).toBe(false)
    expect(vi.mocked(lock)).toHaveBeenLastCalledWith(target, expect.objectContaining({
      stale: 120_000, update: 5000,
      retries: { retries: 60, minTimeout: 200, maxTimeout: 200, factor: 1 },
    }))
  })

  it('reports bounded lock contention as retryable and preserves filesystem errors', async () => {
    vi.mocked(lock).mockRejectedValueOnce(Object.assign(new Error('held'), { code: 'ELOCKED' }))
    await expect(cliInternals.withRuntimeLock('unused', () => {})).rejects.toThrow('retry shortly')
    vi.mocked(lock).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(cliInternals.withRuntimeLock('unused', () => {})).rejects.toThrow('permission denied')
  })

  it('refuses mutation after the lease is reported compromised', async () => {
    const release = vi.fn(async () => {})
    vi.mocked(lock).mockImplementationOnce(async (_path, options) => {
      options?.onCompromised?.(new Error('lease lost'))
      return release
    })
    const mutate = vi.fn()
    await expect(cliInternals.withRuntimeLock('unused', mutate)).rejects.toThrow('lease lost')
    expect(mutate).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('recovers a stale lock left by a killed publisher', async () => {
    const target = join(mkdtempTracked('mayfly-runtime-crash-'), 'cache')
    const modulePath = createRequire(import.meta.url).resolve('proper-lockfile')
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).lock(${JSON.stringify(target)}, {realpath:false}).then(() => { process.stdout.write('locked'); setInterval(() => {}, 1000) })`], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      expect(existsSync(`${target}.lock`)).toBe(true)
      // Advance only this dead owner's lease timestamp, without changing the
      // production lease settings or delaying the test two minutes.
      const stale = new Date(Date.now() - 180_000)
      utimesSync(`${target}.lock`, stale, stale)
      await expect(cliInternals.withRuntimeLock(target, () => 'recovered')).resolves.toBe('recovered')
      expect(existsSync(`${target}.lock`)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })
})
