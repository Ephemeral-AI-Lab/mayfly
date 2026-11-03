/**
 * Alternate-screen ambient-output recovery ownership and write routing.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { createOutputRecovery, type AmbientOutputStream } from '../../src/core/output-recovery.ts'

class RecordingStream implements AmbientOutputStream {
  readonly chunks: string[] = []

  write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): boolean => {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    if (typeof encodingOrCallback === 'function') encodingOrCallback()
    callback?.()
    return true
  }) as NodeJS.WriteStream['write']
}

describe('createOutputRecovery', () => {
  it('repaints after ambient writes but excludes every renderer terminal method', () => {
    const stdout = new RecordingStream()
    const stderr = new RecordingStream()
    const repaint = vi.fn()
    const recovery = createOutputRecovery({ stdout, stderr }, repaint)
    // Every function-valued terminal property brackets its own write; pi-tui
    // reaches process.stdout through cursor, clearing and progress methods
    // too, not only `write`.
    const terminal = {
      write(data: string) { stdout.write(data) },
      hideCursor() { stdout.write('hide-cursor') },
      stop() { stdout.write('stop') },
      columns: 80,
    } as unknown as Terminal
    const originalStdoutWrite = stdout.write
    const originalStderrWrite = stderr.write
    const facade = recovery.renderer(terminal)

    recovery.activate()
    recovery.activate()
    facade.write('renderer frame')
    facade.hideCursor()
    facade.stop()
    expect(repaint).not.toHaveBeenCalled()
    expect(facade.columns).toBe(80)

    const callback = vi.fn()
    expect(stdout.write('host json', callback)).toBe(true)
    stderr.write(Buffer.from('host error'))
    expect(callback).toHaveBeenCalledOnce()
    expect(repaint).toHaveBeenCalledTimes(2)
    expect(stdout.chunks).toEqual(['renderer frame', 'hide-cursor', 'stop', 'host json'])
    expect(stderr.chunks).toEqual(['host error'])

    recovery.deactivate()
    recovery.deactivate()
    expect(stdout.write).toBe(originalStdoutWrite)
    expect(stderr.write).toBe(originalStderrWrite)
    stdout.write('after release')
    expect(repaint).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a stream method replaced by another owner', () => {
    const stdout = new RecordingStream()
    const stderr = new RecordingStream()
    const recovery = createOutputRecovery({ stdout, stderr }, () => {})
    recovery.activate()
    const stdoutReplacement = (() => true) as NodeJS.WriteStream['write']
    const stderrReplacement = (() => true) as NodeJS.WriteStream['write']
    stdout.write = stdoutReplacement
    stderr.write = stderrReplacement

    recovery.deactivate()
    expect(stdout.write).toBe(stdoutReplacement)
    expect(stderr.write).toBe(stderrReplacement)
  })

  it('releases renderer-write depth when the underlying terminal throws', () => {
    const stdout = new RecordingStream()
    const stderr = new RecordingStream()
    const terminal = {
      write: (_data: string) => { throw new Error('terminal failed') },
    } as unknown as Terminal
    const repaint = vi.fn()
    const recovery = createOutputRecovery({ stdout, stderr }, repaint)
    const facade = recovery.renderer(terminal)
    recovery.activate()

    expect(() => facade.write('frame')).toThrow('terminal failed')
    stdout.write('external after failure')
    expect(repaint).toHaveBeenCalledOnce()
    recovery.deactivate()
  })
})
