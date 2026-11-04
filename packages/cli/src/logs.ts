/** Bounded rotating service logs with credential redaction and cancellable tailing. @module */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delay } from './state.ts'

/** Scrub structured authentication fields before persisting native diagnostics. */
export function redact(text: string): string {
  return text.replace(/([?&](?:token|cookie)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/((?:cookie|authorization)\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
}

/** Append a complete diagnostic after rotating up to five 10 MiB files. */
export function appendLog(file: string, text: string, limit = 10 * 1024 * 1024): void {
  const safe = redact(text)
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(safe) > limit) {
    if (existsSync(`${file}.4`)) unlinkSync(`${file}.4`)
    for (let index = 3; index >= 1; index--) if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`)
    renameSync(file, `${file}.1`)
  }
  appendFileSync(file, safe, { mode: 0o600 })
}

/** Buffer native stream chunks so a credential split across chunks is still redacted. */
export function logStream(file: string): { write(chunk: Buffer): void, end(): void } {
  let pending = ''
  return {
    write(chunk) {
      pending += chunk.toString('utf8')
      const end = pending.lastIndexOf('\n')
      if (end >= 0) { appendLog(file, pending.slice(0, end + 1)); pending = pending.slice(end + 1) }
      if (pending.length > 64 * 1024) { appendLog(file, '[oversized diagnostic omitted]\n'); pending = '' }
    },
    end() { if (pending) { appendLog(file, `${pending}\n`); pending = '' } },
  }
}

/** Print recent lines and follow rotation until the invocation is cancelled. */
export async function showLogs(file: string, follow: boolean, signal: AbortSignal, output: (text: string) => void): Promise<void> {
  let previous = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  output(previous.split('\n').slice(-101).join('\n'))
  while (follow && !signal.aborted) {
    await delay(250)
    if (signal.aborted) break
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    output(current.startsWith(previous) ? current.slice(previous.length) : current)
    previous = current
  }
}
