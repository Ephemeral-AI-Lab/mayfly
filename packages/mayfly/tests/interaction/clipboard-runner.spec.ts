/** Regression evidence for bounded clipboard subprocesses. */
import { describe, expect, it } from 'vitest'
import { runTool } from '../../src/interaction/clipboard-probe.ts'

describe('clipboard subprocess bounds', () => {
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
