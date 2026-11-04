/** Real rotating-log and cancellation scenarios with tracked fixtures. @module */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'
import { appendLog, logStream, redact, showLogs } from '../src/logs.ts'

registerTempDirCleanup()
it('redacts credentials even when native output splits a token across chunks', async () => {
  const file = join(await mkdtempTracked('mayfly-logs-'), 'server.log')
  const stream = logStream(file)
  stream.write(Buffer.from('URL http://localhost/?to'))
  stream.write(Buffer.from('ken=SECRET&x=1\nAuthorization: bearer SECRET\nlast'))
  stream.end()
  stream.end()
  expect(readFileSync(file, 'utf8')).toBe('URL http://localhost/?token=<redacted>&x=1\nAuthorization: <redacted>\nlast\n')
  expect(redact('Cookie: secret\n?cookie=secret')).toBe('Cookie: <redacted>\n?cookie=<redacted>')
  stream.write(Buffer.from('a'.repeat(65 * 1024)))
  expect(readFileSync(file, 'utf8')).toContain('oversized diagnostic omitted')
})
it('rotates only five files and reads the last hundred complete lines', async () => {
  const file = join(await mkdtempTracked('mayfly-log-rotation-'), 'server.log')
  for (let index = 0; index < 7; index++) appendLog(file, `line ${index}\n`, 8)
  expect(readFileSync(`${file}.4`, 'utf8')).toBe('line 2\n')
  expect(readFileSync(file, 'utf8')).toBe('line 6\n')
  writeFileSync(file, Array.from({ length: 110 }, (_, index) => `${index}\n`).join(''))
  const output: string[] = []
  await showLogs(file, false, new AbortController().signal, text => output.push(text))
  expect(output.join('')).toMatch(/^10\n/u)
})
it('follows appended output and replacement, then retires on cancellation', async () => {
  const file = join(await mkdtempTracked('mayfly-log-follow-'), 'server.log')
  const abort = new AbortController()
  const output: string[] = []
  const following = showLogs(file, true, abort.signal, text => {
    output.push(text)
    if (output.length === 1) writeFileSync(file, 'first\n')
    else if (output.length === 2) writeFileSync(file, 'replacement\n')
    else abort.abort()
  })
  await following
  expect(output).toEqual(['', 'first\n', 'replacement\n'])
  await showLogs(file, true, abort.signal, () => {})
})

it('propagates unreadable logs and cancels during a pending poll', async () => {
  const dir = mkdtempTracked('mayfly-log-errors-')
  await expect(showLogs(dir, false, new AbortController().signal, () => {})).rejects.toThrow()
  const file = join(dir, 'server.log')
  writeFileSync(file, 'old\n')
  const abort = new AbortController()
  let calls = 0
  await showLogs(file, true, abort.signal, () => {
    if (++calls === 1) unlinkSync(file)
    else abort.abort()
  })
  const stop = new AbortController()
  await showLogs(file, true, stop.signal, () => { setTimeout(() => stop.abort(), 10) })
})
