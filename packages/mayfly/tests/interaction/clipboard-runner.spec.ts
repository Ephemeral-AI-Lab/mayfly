/** Regression evidence for bounded clipboard subprocesses. */
import * as childProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { runTool } from '../../src/interaction/clipboard-probe.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

describe('clipboard subprocess bounds', () => {
  it('leaves no deadline or abort listener after a synchronous completion', async () => {
    const signal = new AbortController().signal
    const remove = vi.spyOn(signal, 'removeEventListener')
    const spawn = vi.mocked(childProcess.execFile).mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (error: null, stdout: Buffer, stderr: Buffer) => void
      callback(null, Buffer.from('done'), Buffer.alloc(0))
      return {} as childProcess.ChildProcess
    })
    try {
      await expect(runTool('helper', [], { signal })).resolves.toEqual({ ok: true, stdout: Buffer.from('done') })
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      spawn.mockClear()
      remove.mockRestore()
    }
  })

  it('settles synchronous spawn and stdin argument failures as failures', async () => {
    await expect(runTool('invalid\0command', [])).resolves.toMatchObject({ ok: false, code: 'ERR_INVALID_ARG_VALUE', killed: false })
    await expect(runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { input: 1 as unknown as string })).resolves.toMatchObject({ ok: false, code: 'ERR_INVALID_ARG_TYPE', killed: false })
  })

  it('passes text on stdin without losing Unicode or punctuation', async () => {
    const text = 'clipboard: 中文 "quotes" $HOME\nsecond line'
    const result = await runTool(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: text })
    expect(result).toEqual({ ok: true, stdout: Buffer.from(text) })
  })

  it('accepts exit zero when a helper closes stdin without reading it', async () => {
    const result = await runTool(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(0)'], { input: 'x'.repeat(1024 * 1024) })
    expect(result).toEqual({ ok: true, stdout: Buffer.alloc(0) })
  })

  it('returns on its deadline even when the helper ignores SIGTERM', async () => {
    const start = Date.now()
    const result = await runTool(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 200 })
    expect(result).toEqual({ ok: false, code: 'ETIMEDOUT', killed: true, stderr: '' })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('classifies output overflow separately from timeout', async () => {
    const result = await runTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536))'], { maxBuffer: 1024 })
    expect(result).toMatchObject({ ok: false, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: false })
  })

  it('supports cancellation before spawn and during a live helper', async () => {
    const already = AbortSignal.abort()
    await expect(runTool(process.execPath, [], { signal: already })).resolves.toMatchObject({ ok: false, code: 'ABORT_ERR', killed: false })
    const controller = new AbortController()
    const result = runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
    controller.abort()
    await expect(result).resolves.toMatchObject({ ok: false, code: 'ABORT_ERR', killed: false })
  })
})
