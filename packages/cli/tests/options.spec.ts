/** User-facing command selection and argument boundary coverage. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, actions, HELP } from '../src/options.ts'

afterEach(() => vi.unstubAllEnvs())
describe('unified CLI grammar', () => {
  it('defaults to the TUI and reserves server as the first positional command', () => {
    expect(parse([])).toMatchObject({ server: false, profile: 'mayfly', action: 'start' })
    expect(parse(['server'])).toMatchObject({ server: true, action: 'start' })
    for (const action of actions) expect(parse(['server', action]).action).toBe(action)
    expect(parse(['--', 'server', 'write', 'tests']).remote).toEqual(['--', 'server', 'write', 'tests'])
    expect(HELP).toContain('Quitting detaches only the UI')
  })
  it('parses explicit profiles, native bind settings and action-specific flags', () => {
    for (const flags of [['--profile', 'work', '--host', '127.0.0.1', '--port', '0'], ['--profile=work', '--host=127.0.0.1', '--port=0']]) {
      expect(parse(['server', 'start', ...flags])).toMatchObject({ profile: 'work', explicitProfile: true, host: '127.0.0.1', port: 0 })
    }
    expect(parse(['server', 'logs', '--follow']).follow).toBe(true)
    expect(parse(['server', 'restart', '--print-startup-url']).printUrl).toBe(true)
    expect(parse(['-h']).help).toBe(true)
    expect(parse(['--help']).help).toBe(true)
    expect(parse(['-V']).version).toBe(true)
    expect(parse(['--version']).version).toBe(true)
  })
  it('preserves Remote option values and positional tasks without consuming their flags', () => {
    const args = ['--resume', 'session', '--cwd', '/tmp', '--session=id', 'do', 'work']
    expect(parse(['--profile=work', ...args]).remote).toEqual(args)
    expect(parse(['--cwd', '--profile']).remote).toEqual(['--cwd', '--profile'])
    expect(parse(['--resume']).remote).toEqual(['--resume'])
    expect(parse(['--host', 'https://example.test']).remote).toEqual(['--host', 'https://example.test'])
  })
  it.each([
    ['server', 'unknown'], ['server', '--unknown'], ['server', '--'],
    ['--profile'], ['--profile='], ['--profile', '--help'], ['--profile=../bad'],
    ['server', '--port=-1'], ['server', '--port=no'], ['server', '--port=65536'],
    ['server', 'status', '--port=1'], ['server', 'stop', '--host=127.0.0.1'],
    ['server', 'start', '--follow'], ['server', 'logs', '--print-startup-url'],
  ])('rejects invalid input %j', (...args) => expect(() => parse(args)).toThrow())
  it('rejects ambiguous remote and explicit local profile selection', () => {
    expect(() => parse(['--profile=work', '--host=https://example.test'])).toThrow('cannot be combined')
    vi.stubEnv('MAYFLY_DSH_STARTUP_URL', 'https://example.test/?token=secret')
    expect(() => parse(['--profile=work'])).toThrow('cannot be combined')
    expect(parse([]).explicitProfile).toBe(false)
    expect(parse(['server', 'status', '--profile=work']).profile).toBe('work')
  })
})
