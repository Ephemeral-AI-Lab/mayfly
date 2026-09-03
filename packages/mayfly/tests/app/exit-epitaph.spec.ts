/** Process-exit epitaph formatting and writer tests. @module mayfly-app/exit-epitaph-tests */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armExitEpitaph,
  armedEpitaph,
  epitaphFor,
  profileFromArgv,
  setExitEpitaphWriter,
  writeArmedEpitaph,
} from '../../src/app/exit-epitaph.ts'

afterEach(() => {
  armExitEpitaph(undefined)
  setExitEpitaphWriter(undefined)
  vi.restoreAllMocks()
})

describe('exit epitaph', () => {
  it('flushes the latest armed text and skips an empty slot', () => {
    const written: string[] = []
    setExitEpitaphWriter(text => { written.push(text) })
    armExitEpitaph('first')
    armExitEpitaph('latest')
    expect(armedEpitaph()).toBe('latest')
    writeArmedEpitaph()
    armExitEpitaph(undefined)
    writeArmedEpitaph()
    expect(written).toEqual(['latest'])
  })

  it('restores the synchronous stdout writer', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setExitEpitaphWriter(undefined)
    armExitEpitaph('to stdout')
    writeArmedEpitaph()
    expect(write).toHaveBeenCalledWith('to stdout')
  })

  it('reads both profile flag forms and rejects flag-shaped followers', () => {
    expect(profileFromArgv(['dsh'])).toBe('mayfly')
    expect(profileFromArgv(['dsh', '--profile', 'tui', '--resume', 'x'])).toBe('tui')
    expect(profileFromArgv(['dsh', '--profile=direct'])).toBe('direct')
    expect(profileFromArgv(['dsh', '--profile', '--resume', 'x'])).toBe('mayfly')
    expect(profileFromArgv(['dsh', '--profile'])).toBe('mayfly')
  })

  it('places the resume command on its own line', () => {
    expect(epitaphFor('session-abc', 'mayfly')).toBe(
      'mayfly · session saved · resume with:\ndsh --profile mayfly --resume session-abc\n',
    )
  })
})
